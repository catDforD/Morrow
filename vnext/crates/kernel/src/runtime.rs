use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, broadcast};
use tokio_util::sync::CancellationToken;

use crate::{
    projection::Projection,
    protocol::*,
    rpc::Peer,
    store::{SessionStore, digest, valid_id},
};

pub struct Session {
    pub store: Mutex<SessionStore>,
    pub cancel: Mutex<CancellationToken>,
    pub changed: Notify,
    pub progress: Mutex<Option<(String, u64)>>,
}

pub struct Runtime {
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub peer: Mutex<Option<Arc<Peer>>>,
    pub ready: Notify,
    pub events: broadcast::Sender<Value>,
    pub shutdown: CancellationToken,
    pub auto_approve: bool,
}

pub fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params[key]
        .as_str()
        .with_context(|| format!("missing {key}"))
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Runtime {
    pub async fn session(&self, name: &str) -> Result<Arc<Session>> {
        valid_id(name)?;
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(name) {
            return Ok(session.clone());
        }
        let store = SessionStore::open(
            &crate::sessions::path(&self.home, &self.workspace, name)?,
            &self.workspace,
            None,
        )?;
        let session = Arc::new(Session {
            store: Mutex::new(store),
            cancel: Mutex::new(CancellationToken::new()),
            changed: Notify::new(),
            progress: Mutex::new(None),
        });
        sessions.insert(name.into(), session.clone());
        Ok(session)
    }

    pub async fn snapshot(&self, name: &str) -> Result<Projection> {
        Ok(self
            .session(name)
            .await?
            .store
            .lock()
            .await
            .projection
            .clone())
    }

    pub async fn commit(&self, name: &str, fact: Fact) -> Result<Record> {
        let session = self.session(name).await?;
        let record = session.store.lock().await.commit(fact)?;
        let _ = self
            .events
            .send(json!({"type":"fact","session":name,"record":record}));
        session.changed.notify_waiters();
        Ok(record)
    }

    async fn commit_host(&self, name: &str, params: &Value, fact: Fact) -> Result<Record> {
        let session = self.session(name).await?;
        let mut store = session.store.lock().await;
        if let Some(run) = params["run"].as_str() {
            store.projection.require_run(run)?;
            ensure!(!session.cancel.lock().await.is_cancelled(), "run cancelled");
        }
        if let Some(step) = params["step"].as_str() {
            store.projection.require_step(step)?;
        }
        let record = store.commit(fact)?;
        let _ = self
            .events
            .send(json!({"type":"fact","session":name,"record":record}));
        session.changed.notify_waiters();
        Ok(record)
    }

    pub async fn attach(&self, peer: Arc<Peer>) -> Result<()> {
        let mut current = self.peer.lock().await;
        ensure!(
            current.as_ref().is_none_or(|p| p.closed.is_cancelled()),
            "another plugin host is connected"
        );
        *current = Some(peer);
        Ok(())
    }

    pub async fn detach(&self, peer: &Peer) {
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            if session
                .store
                .lock()
                .await
                .projection
                .run
                .as_ref()
                .is_some_and(|r| r.epoch == peer.epoch)
            {
                session.cancel.lock().await.cancel();
            }
        }
        let _ = self.events.send(json!({"type":"host_disconnected"}));
    }

    pub async fn host(&self) -> Result<Arc<Peer>> {
        self.peer
            .lock()
            .await
            .clone()
            .filter(|p| !p.closed.is_cancelled())
            .context("plugin host unavailable; restart host before executing")
    }

    pub async fn submit(
        self: &Arc<Self>,
        name: &str,
        submission: &str,
        text: &str,
    ) -> Result<Value> {
        ensure!(!text.trim().is_empty(), "empty input");
        let session = self.session(name).await?;
        {
            let mut store = session.store.lock().await;
            if let Some(message) = store.projection.inputs.get(submission) {
                ensure!(
                    message.content == text,
                    "submission id reused with different input"
                );
                return Ok(
                    json!({"duplicate":true,"queued":!store.projection.claimed.contains(submission)}),
                );
            }
            self.host().await?;
            let record = store.commit(Fact::InputQueued {
                submission: submission.into(),
                message: Message::text(Role::User, text),
            })?;
            let _ = self
                .events
                .send(json!({"type":"fact","session":name,"record":record}));
        }
        self.kick(name.to_owned());
        Ok(json!({"queued":true,"submission":submission}))
    }

    fn kick(self: &Arc<Self>, name: String) {
        // Submitting input only enqueues durable work. A detached task drains that
        // queue so the HTTP/CLI caller gets a receipt without waiting for a run.
        let runtime = self.clone();
        tokio::spawn(async move {
            if let Err(error) = runtime.drain(&name).await {
                let _ = runtime
                    .events
                    .send(json!({"type":"error","session":name,"error":error.to_string()}));
            }
        });
    }

    async fn drain(self: &Arc<Self>, name: &str) -> Result<()> {
        let session = self.session(name).await?;
        loop {
            let peer = self.host().await?;
            let run = id();
            let cancel = CancellationToken::new();
            {
                let mut store = session.store.lock().await;
                if store.projection.run.is_some() {
                    return Ok(());
                }
                // Preserve submission order from the log, not lexical id order.
                let submission = store.records.iter().find_map(|r| match &r.fact {
                    Fact::InputQueued { submission, .. }
                        if !store.projection.claimed.contains(submission) =>
                    {
                        Some(submission.clone())
                    }
                    _ => None,
                });
                let Some(submission) = submission else {
                    return Ok(());
                };
                *session.cancel.lock().await = cancel.clone();
                let record = store.commit(Fact::RunStarted {
                    run: run.clone(),
                    submission,
                    epoch: peer.epoch.clone(),
                })?;
                let _ = self
                    .events
                    .send(json!({"type":"fact","session":name,"record":record}));
            }
            let snapshot = self.snapshot(name).await?;
            let workspace = self.snapshot("_workspace").await?;
            // The Host owns the agent loop; Rust retains authority over every
            // state-changing RPC that the loop makes while this run is active.
            let task = peer.call("driver.run", json!({"session":name,"run":run,"epoch":peer.epoch,"snapshot":snapshot,"workspace":workspace}));
            tokio::pin!(task);
            let (outcome, reason) = tokio::select! {
                result = &mut task => match result { Ok(_) => (Outcome::Completed, String::new()), Err(e) => (Outcome::Failed, e.to_string()) },
                () = cancel.cancelled() => {
                    let _ = peer.notify("run.cancel", json!({"run":run}));
                    if tokio::time::timeout(Duration::from_secs(5), &mut task).await.is_err() { peer.disconnect(); }
                    (Outcome::Cancelled, "run cancelled".into())
                }
            };
            cancel.cancel();
            {
                let mut store = session.store.lock().await;
                let from = store.records.len();
                if outcome == Outcome::Completed && store.projection.step.is_none() {
                    store.commit(Fact::RunEnded {
                        run,
                        outcome,
                        reason,
                    })?;
                } else {
                    // A driver crash or cancellation can leave an open effect or
                    // tool group. Close it with explicit durable outcomes so a
                    // restart never guesses whether external work was repeated.
                    store.finish_interrupted(&reason, outcome)?;
                }
                for record in &store.records[from..] {
                    let _ = self
                        .events
                        .send(json!({"type":"fact","session":name,"record":record}));
                }
            }
            session.changed.notify_waiters();
            // Explicit cancellation does not consume already queued inputs.
            if cancel.is_cancelled()
                && self.snapshot(name).await?.last_outcome != Some(Outcome::Completed)
            {
                return Ok(());
            }
        }
    }

    pub async fn cancel(&self, name: &str) -> Result<()> {
        self.session(name).await?.cancel.lock().await.cancel();
        Ok(())
    }

    pub async fn approval(&self, name: &str, approval: &str, approved: bool) -> Result<()> {
        self.commit(
            name,
            Fact::ApprovalDecided {
                id: approval.into(),
                approved,
            },
        )
        .await?;
        Ok(())
    }

    async fn validate_handle(&self, peer: &Peer, params: &Value) -> Result<(String, Arc<Session>)> {
        ensure!(
            !peer.closed.is_cancelled() && self.host().await?.epoch == peer.epoch,
            "stale host epoch"
        );
        ensure!(string(params, "epoch")? == peer.epoch, "stale handle epoch");
        let name = string(params, "session")?.to_owned();
        ensure!(name != "_workspace", "reserved session");
        let session = self.session(&name).await?;
        if let Some(run) = params["run"].as_str() {
            session.store.lock().await.projection.require_run(run)?;
            ensure!(!session.cancel.lock().await.is_cancelled(), "run cancelled");
        }
        Ok((name, session))
    }

    pub async fn host_rpc(
        self: &Arc<Self>,
        peer: &Arc<Peer>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if method == "host.ready" {
            self.ready.notify_one();
            return Ok(json!({"epoch":peer.epoch,"protocol":PROTOCOL_VERSION}));
        }
        let (name, session) = self.validate_handle(peer, &params).await?;
        match method {
            "model.progress" => {
                let request = string(&params, "request")?;
                let store = session.store.lock().await;
                store.projection.require_step(string(&params, "step")?)?;
                ensure!(
                    store
                        .projection
                        .effects
                        .get(request)
                        .is_some_and(|e| e.kind == "model" && e.outcome.is_none()),
                    "inactive model progress"
                );
                let sequence = params["sequence"]
                    .as_u64()
                    .context("missing progress sequence")?;
                let mut last = session.progress.lock().await;
                if last
                    .as_ref()
                    .is_some_and(|(id, seq)| id == request && *seq >= sequence)
                {
                    return Ok(Value::Null);
                }
                ensure!(
                    serde_json::to_vec(&params["events"])?.len() <= 65_536,
                    "progress batch too large"
                );
                *last = Some((request.into(), sequence));
                let purpose = &store.projection.requests[request].purpose;
                let _ = self.events.send(json!({"type":"model_progress","session":name,"run":params["run"],"step":params["step"],"request":request,"sequence":sequence,"purpose":purpose,"events":params["events"]}));
                Ok(Value::Null)
            }
            "session.get" => Ok(json!(session.store.lock().await.projection)),
            "workspace.get" => Ok(json!(self.snapshot("_workspace").await?)),
            "step.begin" => {
                let registrations: Vec<Registration> =
                    serde_json::from_value(params["registrations"].clone())?;
                self.commit(
                    &name,
                    Fact::StepStarted {
                        run: string(&params, "run")?.into(),
                        step: string(&params, "step")?.into(),
                        registrations,
                    },
                )
                .await?;
                Ok(Value::Null)
            }
            "step.end" => {
                self.commit(
                    &name,
                    Fact::StepEnded {
                        step: string(&params, "step")?.into(),
                    },
                )
                .await?;
                Ok(Value::Null)
            }
            "model.call" => self.model_call(peer, &name, &params).await,
            "tools.call" => self.tool_call(peer, &name, &params).await,
            "tools.settle" => {
                let call = string(&params, "call")?;
                let store = &mut *session.store.lock().await;
                store.projection.require_step(string(&params, "step")?)?;
                let record = store.commit(Fact::ToolSettled {
                    call: call.into(),
                    message: Message::tool(call, params["output"].to_string()),
                })?;
                let _ = self
                    .events
                    .send(json!({"type":"fact","session":name,"record":record}));
                Ok(Value::Null)
            }
            "context.append" => {
                self.commit(
                    &name,
                    Fact::ContextAppended {
                        id: id(),
                        message: serde_json::from_value(params["message"].clone())?,
                    },
                )
                .await?;
                Ok(Value::Null)
            }
            "context.replace" => {
                let mut store = session.store.lock().await;
                store.projection.require_step(string(&params, "step")?)?;
                let start = string(&params, "start")?.to_owned();
                let end = string(&params, "end")?.to_owned();
                let covers = store.projection.replacement_covers(&start, &end)?;
                let revision = params["revision"]
                    .as_u64()
                    .context("missing revision")?
                    .try_into()?;
                let record = store.commit(Fact::SurfaceReplaced {
                    revision,
                    start,
                    end,
                    id: id(),
                    message: serde_json::from_value(params["message"].clone())?,
                    covers,
                    source_request: params["source_request"].as_str().map(String::from),
                })?;
                let _ = self
                    .events
                    .send(json!({"type":"fact","session":name,"record":record}));
                Ok(json!({"revision":store.projection.revision}))
            }
            "plugin.define" => {
                let manifest: PluginManifest = serde_json::from_value(params["manifest"].clone())?;
                self.define(&name, manifest).await
            }
            "plugin.activate" | "plugin.stop" => {
                let hash = string(&params, "hash")?;
                self.bind(&name, hash, method == "plugin.activate").await?;
                Ok(json!({"pending":true,"boundary":"next_step"}))
            }
            "state.set" | "state.delete" | "fact.emit" => {
                let namespace = string(&params, "namespace")?;
                ensure!(
                    params["owner"]["plugin"].as_str() == Some(namespace),
                    "plugin state namespace mismatch"
                );
                let fact = match method {
                    "state.set" => Fact::PluginStateSet {
                        namespace: namespace.into(),
                        key: string(&params, "key")?.into(),
                        value: params["value"].clone(),
                    },
                    "state.delete" => Fact::PluginStateDeleted {
                        namespace: namespace.into(),
                        key: string(&params, "key")?.into(),
                    },
                    _ => Fact::PluginEvent {
                        namespace: namespace.into(),
                        version: params["version"]
                            .as_u64()
                            .context("missing version")?
                            .try_into()?,
                        name: string(&params, "name")?.into(),
                        data: params["data"].clone(),
                    },
                };
                self.commit_host(&name, &params, fact).await?;
                Ok(Value::Null)
            }
            "subagent.run" => {
                let child = format!("child-{}", id());
                let snapshot = self.snapshot(&name).await?;
                let mut depth = 0;
                let mut parent = snapshot.parent.clone();
                while let Some(name) = parent {
                    depth += 1;
                    ensure!(depth < 3, "subagent nesting limit reached");
                    parent = self.snapshot(&name).await?.parent;
                }
                let store = SessionStore::open(
                    &crate::sessions::path(&self.home, &self.workspace, &child)?,
                    &self.workspace,
                    Some(name.clone()),
                )?;
                let child_session = Arc::new(Session {
                    store: Mutex::new(store),
                    cancel: Mutex::new(CancellationToken::new()),
                    changed: Notify::new(),
                    progress: Mutex::new(None),
                });
                self.sessions
                    .lock()
                    .await
                    .insert(child.clone(), child_session.clone());
                let parent_cancel = session.cancel.lock().await.clone();
                // Copy durable bindings and state, never live handles or consumed work.
                for version in snapshot.plugins.values() {
                    self.commit(
                        &child,
                        Fact::PluginDefined {
                            version: version.clone(),
                        },
                    )
                    .await?;
                }
                for hash in snapshot.trusted {
                    self.commit(&child, Fact::PluginTrusted { hash }).await?;
                }
                for (plugin_name, binding) in snapshot.bindings {
                    self.commit(
                        &child,
                        Fact::PluginBound {
                            name: plugin_name,
                            hash: binding.hash,
                            active: binding.active,
                        },
                    )
                    .await?;
                }
                for (namespace, entries) in snapshot.plugin_state {
                    for (key, value) in entries {
                        self.commit(
                            &child,
                            Fact::PluginStateSet {
                                namespace: namespace.clone(),
                                key,
                                value,
                            },
                        )
                        .await?;
                    }
                }
                self.commit(
                    &name,
                    Fact::PluginEvent {
                        namespace: "morrow.subagent".into(),
                        version: 1,
                        name: "spawned".into(),
                        data: json!({"child":child}),
                    },
                )
                .await?;
                self.submit(&child, &id(), string(&params, "prompt")?)
                    .await?;
                loop {
                    let notified = child_session.changed.notified();
                    let state = self.snapshot(&child).await?;
                    if state.last_outcome.is_some() {
                        return Ok(
                            json!({"session":child,"outcome":state.last_outcome,"messages":state.messages(&state.surface)?}),
                        );
                    }
                    tokio::select! {
                        () = notified => {},
                        () = peer.closed.cancelled() => { self.cancel(&child).await?; bail!("host disconnected"); },
                        () = parent_cancel.cancelled() => { self.cancel(&child).await?; bail!("parent cancelled"); },
                    }
                }
            }
            _ => bail!("unknown host method {method}"),
        }
    }

    pub async fn migrate(&self, source: &str, target: &str) -> Result<Value> {
        valid_id(target)?;
        let workspace = source == "_workspace" && target == "_workspace";
        ensure!(
            workspace || (target != "_workspace" && source != target),
            "choose a new session id"
        );
        let session = self.session(source).await?;
        let mut source_store = session.store.lock().await;
        let legacy = source_store
            .legacy
            .as_mut()
            .context("source is not a v1 session")?;
        let last = legacy.records.last().context("empty legacy log")?;
        let (seq, hash) = (last.seq, last.hash.clone());
        legacy.recover_for_import()?;
        let state = legacy.normalized()?;
        let destination = if workspace {
            self.home.join("sessions").join(format!(
                "workspace-v2-{}.jsonl",
                digest(self.workspace.to_string_lossy().as_bytes())
            ))
        } else {
            crate::sessions::path(&self.home, &self.workspace, target)?
        };
        ensure!(!destination.exists(), "target session already exists");
        let directory = destination.parent().context("missing session directory")?;
        std::fs::create_dir_all(directory)?;
        let temporary = directory.join(format!("migration-{}.tmp", id()));
        let result = (|| -> Result<()> {
            let mut store = SessionStore::open(&temporary, &self.workspace, state.parent.clone())?;
            store.commit(Fact::SessionImported {
                source: source.into(),
                seq,
                hash,
                nodes: state.nodes,
                surface: state.surface,
            })?;
            for version in state.plugins.into_values() {
                store.commit(Fact::PluginDefined { version })?;
            }
            for hash in state.trusted {
                store.commit(Fact::PluginTrusted { hash })?;
            }
            for (name, binding) in state.bindings {
                store.commit(Fact::PluginBound {
                    name,
                    hash: binding.hash,
                    active: binding.active,
                })?;
            }
            for (namespace, entries) in state.plugin_state {
                for (key, value) in entries {
                    store.commit(Fact::PluginStateSet {
                        namespace: namespace.clone(),
                        key,
                        value,
                    })?;
                }
            }
            drop(store);
            let check = SessionStore::open(&temporary, &self.workspace, None)?;
            drop(check);
            // hard_link installs without overwriting an existing destination.
            std::fs::hard_link(&temporary, &destination)?;
            #[cfg(unix)]
            std::fs::File::open(directory)?.sync_all()?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
        drop(source_store);
        if workspace {
            self.sessions.lock().await.remove("_workspace");
        }
        Ok(json!({"session":target,"source":source}))
    }

    pub async fn define(&self, name: &str, manifest: PluginManifest) -> Result<Value> {
        ensure!(
            manifest.host.len() + manifest.client.as_ref().map_or(0, String::len) <= 2_000_000,
            "plugin artifact exceeds 2 MB"
        );
        ensure!(
            !manifest.dependency_lock.trim().is_empty(),
            "plugin requires dependency lock"
        );
        let hash = digest(&serde_json::to_vec(&manifest)?);
        let version = PluginVersion {
            hash: hash.clone(),
            manifest,
        };
        let directory = self.home.join("plugins").join(&hash);
        std::fs::create_dir_all(&directory)?;
        for (file, content) in [
            ("host.mjs", Some(version.manifest.host.as_str())),
            ("client.mjs", version.manifest.client.as_deref()),
        ] {
            if let Some(content) = content {
                write_immutable(&directory.join(file), content.as_bytes())?;
            }
        }
        write_immutable(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&version)?,
        )?;
        let session = self.session(name).await?;
        let mut store = session.store.lock().await;
        if !store.projection.plugins.contains_key(&hash) {
            let record = store.commit(Fact::PluginDefined { version })?;
            let _ = self
                .events
                .send(json!({"type":"fact","session":name,"record":record}));
        }
        Ok(json!({"hash":hash,"trusted":store.projection.trusted.contains(&hash)}))
    }

    pub async fn trust(&self, name: &str, hash: &str) -> Result<()> {
        self.verify_artifact(name, hash).await?;
        self.commit(name, Fact::PluginTrusted { hash: hash.into() })
            .await?;
        Ok(())
    }

    pub async fn verify_artifact(&self, name: &str, hash: &str) -> Result<()> {
        let state = self.snapshot(name).await?;
        let version = state
            .plugins
            .get(hash)
            .context("plugin version not defined")?;
        ensure!(
            digest(&serde_json::to_vec(&version.manifest)?) == hash,
            "plugin hash mismatch"
        );
        let root = self.home.join("plugins").join(hash);
        ensure!(
            std::fs::read_to_string(root.join("host.mjs"))? == version.manifest.host,
            "host artifact changed"
        );
        if let Some(client) = &version.manifest.client {
            ensure!(
                std::fs::read_to_string(root.join("client.mjs"))? == *client,
                "client artifact changed"
            );
        }
        Ok(())
    }

    pub async fn bind(&self, name: &str, hash: &str, active: bool) -> Result<()> {
        self.verify_artifact(name, hash).await?;
        let state = self.snapshot(name).await?;
        let plugin = &state.plugins[hash];
        self.commit(
            name,
            Fact::PluginBound {
                name: plugin.manifest.name.clone(),
                hash: hash.into(),
                active,
            },
        )
        .await?;
        if let Ok(peer) = self.host().await {
            let _ = peer.notify("plugins.changed", json!({"session":name}));
        }
        Ok(())
    }
}

fn write_immutable(path: &Path, content: &[u8]) -> Result<()> {
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(content)?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => ensure!(
            std::fs::read(path)? == content,
            "immutable artifact changed"
        ),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
