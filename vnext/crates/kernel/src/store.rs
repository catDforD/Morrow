use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

use crate::{projection::Projection, protocol::*};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "invalid session id"
    );
    Ok(())
}

pub struct SessionStore {
    file: File,
    pub projection: Projection,
    pub records: Vec<Record>,
    pub legacy: Option<crate::legacy::LegacyLog>,
    poisoned: bool,
}

impl SessionStore {
    pub fn open(path: &Path, workspace: &Path, parent: Option<String>) -> Result<Self> {
        std::fs::create_dir_all(path.parent().context("session path has no parent")?)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        file.try_lock()
            .context("session is already open in another process")?;
        let mut bytes = vec![];
        file.read_to_end(&mut bytes)?;
        if bytes
            .split(|b| *b == b'\n')
            .find(|b| !b.is_empty())
            .is_some_and(|line| {
                serde_json::from_slice::<serde_json::Value>(line)
                    .ok()
                    .is_some_and(|v| v["protocol"] == 1)
            })
        {
            let legacy = crate::legacy::LegacyLog::read(&bytes)?;
            let projection = legacy.normalized()?;
            ensure!(
                Path::new(&projection.workspace) == workspace.canonicalize()?,
                "session belongs to a different workspace"
            );
            return Ok(Self {
                file,
                projection,
                records: vec![],
                legacy: Some(legacy),
                poisoned: false,
            });
        }
        // Only an unterminated final record can be torn. Preserve it before truncating.
        if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
            let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            let backup = path.with_extension(format!("torn-{}", uuid::Uuid::new_v4()));
            let mut tail = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(backup)?;
            tail.write_all(&bytes[end..])?;
            tail.sync_all()?;
            file.set_len(end as u64)?;
            file.sync_all()?;
            bytes.truncate(end);
        }
        let mut store = Self {
            file,
            projection: Projection::default(),
            records: vec![],
            legacy: None,
            poisoned: false,
        };
        for (line, bytes) in bytes
            .split(|b| *b == b'\n')
            .filter(|b| !b.is_empty())
            .enumerate()
        {
            let record: Record = serde_json::from_slice(bytes)
                .with_context(|| format!("corrupt fact at line {}", line + 1))?;
            ensure!(
                record.protocol == PROTOCOL_VERSION && record.seq == store.projection.seq + 1,
                "unsupported protocol or fact sequence gap"
            );
            ensure!(
                record.previous == store.last_hash()
                    && record.hash == record_hash(record.seq, &record.previous, &record.fact)?,
                "fact checksum mismatch at {}",
                record.seq
            );
            store
                .projection
                .apply(&record.fact)
                .with_context(|| format!("invalid fact at {}", record.seq))?;
            store.records.push(record);
        }
        store.file.seek(SeekFrom::End(0))?;
        if store.records.is_empty() {
            store.commit(Fact::SessionOpened {
                workspace: workspace.canonicalize()?.to_string_lossy().into(),
                parent,
            })?;
        }
        ensure!(
            Path::new(&store.projection.workspace) == workspace.canonicalize()?,
            "session belongs to a different workspace"
        );
        store.recover("process restarted")?;
        Ok(store)
    }

    pub fn commit(&mut self, fact: Fact) -> Result<Record> {
        ensure!(
            self.legacy.is_none(),
            "v1 session is read-only; use session migrate to copy it to v2"
        );
        ensure!(
            !self.poisoned,
            "fact writer unavailable after persistence failure; reopen session"
        );
        self.projection.validate(&fact)?;
        let previous = self.last_hash();
        let seq = self.projection.seq + 1;
        let record = Record {
            protocol: PROTOCOL_VERSION,
            seq,
            hash: record_hash(seq, &previous, &fact)?,
            previous,
            fact,
        };
        let mut bytes = serde_json::to_vec(&record)?;
        bytes.push(b'\n');
        // Durability comes before visibility: if this write fails, do not let the
        // in-memory Projection advance beyond the on-disk fact log.
        if let Err(error) = self
            .file
            .write_all(&bytes)
            .and_then(|()| self.file.sync_data())
        {
            self.poisoned = true;
            return Err(error).context("durable fact append failed");
        }
        // `validate` above made this reducer call safe. Reusing the reducer here
        // and during `open()` keeps live state and recovered state identical.
        self.projection.apply_validated(&record.fact);
        self.records.push(record.clone());
        Ok(record)
    }

    pub fn recover(&mut self, reason: &str) -> Result<()> {
        self.finish_interrupted(reason, Outcome::Unknown)
    }

    pub fn finish_interrupted(&mut self, reason: &str, outcome: Outcome) -> Result<()> {
        let Some(run) = self.projection.run.clone() else {
            return Ok(());
        };
        let effects: Vec<_> = self
            .projection
            .effects
            .iter()
            .filter(|(_, e)| e.outcome.is_none())
            .map(|(id, _)| id.clone())
            .collect();
        for id in effects {
            self.commit(Fact::EffectSettled {
                id,
                outcome: Outcome::Unknown,
                output: serde_json::json!({"error":reason}),
            })?;
        }
        let requests: Vec<_> = self
            .projection
            .requests
            .keys()
            .filter(|id| !self.projection.settled_requests.contains(*id))
            .cloned()
            .collect();
        for request in requests {
            if let Some(effect) = self.projection.effects.get(&request)
                && effect.outcome == Some(Outcome::Completed)
                && let Ok(result) = serde_json::from_value::<ModelResult>(effect.output.clone())
            {
                self.commit(Fact::ModelSettled {
                    request,
                    result: Some(result),
                    error: None,
                })?;
                continue;
            }
            let status = if self.projection.effects.contains_key(&request) {
                "outcome unknown"
            } else {
                "not started"
            };
            self.commit(Fact::ModelSettled {
                request,
                result: None,
                error: Some(ModelError {
                    code: "interrupted".into(),
                    message: format!("{reason}: {status}"),
                    details: serde_json::Value::Null,
                }),
            })?;
        }
        let calls = self.projection.pending_tools.clone();
        for call in calls {
            if !self.projection.pending_tools.contains(&call)
                || self.projection.tool_results.contains_key(&call)
            {
                continue;
            }
            let effect = self.projection.effects.values().find(|e| {
                e.run == run.id
                    && self
                        .projection
                        .step
                        .as_ref()
                        .is_some_and(|step| step.id == e.step)
                    && e.input.get("call").and_then(|v| v.as_str()) == Some(&call)
            });
            let content = match effect {
                Some(e) if e.outcome == Some(Outcome::Completed) => e.output.to_string(),
                Some(e) => format!(
                    "Tool interrupted ({:?}): {reason}. Do not assume its side effects were rolled back.",
                    e.outcome
                ),
                None => format!("Tool not started: {reason}"),
            };
            self.commit(Fact::ToolSettled {
                message: Message::tool(&call, content),
                call,
            })?;
        }
        let approvals: Vec<_> = self
            .projection
            .approvals
            .iter()
            .filter(|(_, a)| a.approved.is_none())
            .map(|(id, _)| id.clone())
            .collect();
        for id in approvals {
            self.commit(Fact::ApprovalDecided {
                id,
                approved: false,
            })?;
        }
        if let Some(step) = self.projection.step.clone() {
            self.commit(Fact::StepEnded { step: step.id })?;
        }
        self.commit(Fact::RunEnded {
            run: run.id,
            outcome,
            reason: reason.into(),
        })?;
        Ok(())
    }

    pub fn facts(&self) -> Result<serde_json::Value> {
        if let Some(legacy) = &self.legacy {
            return Ok(serde_json::to_value(&legacy.records)?);
        }
        Ok(serde_json::to_value(&self.records)?)
    }

    pub fn audit(&self, id: &str) -> Result<serde_json::Value> {
        if let Some(legacy) = &self.legacy {
            return legacy.audit(id);
        }
        let request = self
            .projection
            .requests
            .get(id)
            .context("unknown request")?;
        Ok(
            serde_json::json!({"protocol":2,"prepared":request,"input":self.projection.reconstruct(request)?,"plan":request.plan}),
        )
    }

    fn last_hash(&self) -> String {
        self.records
            .last()
            .map(|r| r.hash.clone())
            .unwrap_or_default()
    }
}

fn record_hash(seq: u32, previous: &str, fact: &Fact) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        PROTOCOL_VERSION,
        seq,
        previous,
        fact,
    ))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failed_preparation_append_never_dispatches_provider_execution() {
        use crate::{rpc::Peer, runtime::Runtime};
        use serde_json::{Value, json};
        use std::{collections::HashMap, sync::Arc};
        use tokio::sync::{Mutex, Notify, broadcast};
        use tokio_util::sync::CancellationToken;
        let root =
            std::env::temp_dir().join(format!("morrow-provider-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let runtime = Arc::new(Runtime {
            home: root.clone(),
            workspace: root.clone(),
            sessions: Mutex::new(HashMap::new()),
            peer: Mutex::new(None),
            ready: Notify::new(),
            events: broadcast::channel(32).0,
            shutdown: CancellationToken::new(),
            auto_approve: false,
        });
        let session = runtime.session("test").await.unwrap();
        let registration = Registration {
            kind: "model".into(),
            name: "test".into(),
            plugin: "test".into(),
            version: "1".into(),
            scope: "application".into(),
            epoch: "epoch".into(),
            generation: 0,
            tool: None,
        };
        {
            let mut store = session.store.lock().await;
            store
                .commit(Fact::InputQueued {
                    submission: "i".into(),
                    message: Message::text(Role::User, "hello"),
                })
                .unwrap();
            store
                .commit(Fact::RunStarted {
                    run: "r".into(),
                    submission: "i".into(),
                    epoch: "epoch".into(),
                })
                .unwrap();
            store
                .commit(Fact::StepStarted {
                    run: "r".into(),
                    step: "s".into(),
                    registrations: vec![registration],
                })
                .unwrap();
        }
        let (peer, mut calls) = Peer::test_connection();
        let task_runtime = runtime.clone();
        let task_peer = peer.clone();
        let task = tokio::spawn(async move {
            task_runtime.model_call(&task_peer,"test", &json!({"id":"request","run":"r","step":"s","purpose":"main","header":{"provider":"test","model":"m","system":"","tools":[],"parameters":{}}})).await
        });
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), calls.recv())
            .await
            .unwrap()
            .unwrap();
        let axum::extract::ws::Message::Text(message) = message else {
            panic!("expected request")
        };
        let value: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(value["method"], "provider.prepare");
        session.store.lock().await.file =
            File::open(crate::sessions::path(&root, &root, "test").unwrap()).unwrap();
        peer.test_reply(
            value["id"].as_str().unwrap(),
            json!({"format":"test","payload":{}}),
        );
        assert!(task.await.unwrap().is_err());
        assert!(calls.try_recv().is_err());
        let store = session.store.lock().await;
        assert!(store.projection.requests["request"].plan.is_none());
        assert!(store.projection.effects.is_empty());
        assert!(store.poisoned);
        drop(store);
        drop(session);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_durable_append_never_updates_projection_and_poisoned_writer_rejects_later_work() {
        let root =
            std::env::temp_dir().join(format!("morrow-write-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let mut store = SessionStore::open(&path, &root, None).unwrap();
        let before = store.projection.clone();
        // A read-only descriptor deterministically fails write_all without touching user storage.
        store.file = File::open(&path).unwrap();
        let fact = Fact::InputQueued {
            submission: "input".into(),
            message: Message::text(Role::User, "never dispatched"),
        };
        assert!(store.commit(fact.clone()).is_err());
        assert_eq!(store.projection, before);
        assert!(
            store
                .commit(fact)
                .unwrap_err()
                .to_string()
                .contains("writer unavailable")
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
