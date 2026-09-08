use crate::{
    protocol::*,
    rpc::Peer,
    runtime::{Runtime, string},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

impl Runtime {
    pub async fn model_call(
        &self,
        peer: &Arc<Peer>,
        session: &str,
        params: &Value,
    ) -> Result<Value> {
        let handle = self.session(session).await?;
        let cancel = handle.cancel.lock().await.clone();
        let mut request = {
            let mut store = handle.store.lock().await;
            ensure!(!cancel.is_cancelled(), "run cancelled");
            let request = PreparedRequest {
                id: string(params, "id")?.into(),
                run: string(params, "run")?.into(),
                step: string(params, "step")?.into(),
                purpose: string(params, "purpose")?.into(),
                revision: store.projection.revision,
                surface: match params.get("surface") {
                    Some(value) => serde_json::from_value(value.clone())?,
                    None => store.projection.surface.clone(),
                },
                temporary: serde_json::from_value(
                    params.get("temporary").cloned().unwrap_or(json!([])),
                )?,
                header: serde_json::from_value(params["header"].clone())?,
                registrations: store
                    .projection
                    .step
                    .as_ref()
                    .context("no active step")?
                    .registrations
                    .clone(),
                plan: None,
                retry_of: params["retry_of"].as_str().map(String::from),
            };
            let record = store.commit(Fact::ModelRequested {
                request: request.clone(),
            })?;
            let _ = self
                .events
                .send(json!({"type":"fact","session":session,"record":record}));
            request
        };
        let registration = request
            .registrations
            .iter()
            .find(|r| r.kind == "model" && r.name == request.header.provider)
            .context("provider not registered")?
            .clone();
        let execution = async {
            let input = handle.store.lock().await.projection.reconstruct(&request)?;
            let prepared = peer.call("provider.prepare", json!({"registration":registration,"context":params,"request":request,"input":input})).await?;
            request.plan = Some(serde_json::from_value(prepared)?);
            {
                let mut store = handle.store.lock().await;
                ensure!(!cancel.is_cancelled(), "run cancelled");
                // 先记录准备结果和执行许可；释放锁后才让 Node 连接模型。
                for fact in [
                    Fact::RequestPrepared {
                        request: request.clone(),
                    },
                    Fact::EffectStarted {
                        id: request.id.clone(),
                        run: request.run.clone(),
                        step: request.step.clone(),
                        kind: "model".into(),
                        name: request.header.provider.clone(),
                        input: json!({"request":request.id}),
                    },
                ] {
                    let record = store.commit(fact)?;
                    let _ = self
                        .events
                        .send(json!({"type":"fact","session":session,"record":record}));
                }
            }
            let value = peer
                .call(
                    "provider.execute",
                    json!({"registration":registration,"context":params,"request":request}),
                )
                .await?;
            let result: ModelResult = serde_json::from_value(value)?;
            validate_model_result(&result, &request)?;
            Ok(result)
        };
        let result: Result<ModelResult> = tokio::select! {
            result = execution => result,
            () = cancel.cancelled() => bail!("model cancelled; outcome unknown"),
        };
        let error = result.as_ref().err().map(model_error);
        let mut store = handle.store.lock().await;
        store.projection.require_step(&request.step)?;
        ensure!(!cancel.is_cancelled(), "run cancelled");
        if store.projection.effects.contains_key(&request.id) {
            let outcome = match &error {
                None => Outcome::Completed,
                Some(e) if e.code == "transport" || e.details["outcome"] == "unknown" => {
                    Outcome::Unknown
                }
                Some(_) => Outcome::Failed,
            };
            let output = match &result {
                Ok(value) => json!(value),
                Err(_) => json!({"error":error}),
            };
            let record = store.commit(Fact::EffectSettled {
                id: request.id.clone(),
                outcome,
                output,
            })?;
            let _ = self
                .events
                .send(json!({"type":"fact","session":session,"record":record}));
        }
        let record = store.commit(Fact::ModelSettled {
            request: request.id,
            result: result.as_ref().ok().cloned(),
            error: error.clone(),
        })?;
        let _ = self
            .events
            .send(json!({"type":"fact","session":session,"record":record}));
        handle.changed.notify_waiters();
        match result {
            Ok(result) => Ok(json!(result.message)),
            Err(_) => Err(error.unwrap().into()),
        }
    }

    pub async fn tool_call(
        &self,
        peer: &Arc<Peer>,
        session: &str,
        params: &Value,
    ) -> Result<Value> {
        let handle = self.session(session).await?;
        let effect_id = string(params, "id")?.to_owned();
        let name = string(params, "name")?.to_owned();
        let step = string(params, "step")?.to_owned();
        let run = string(params, "run")?.to_owned();
        let (registration, call) = {
            let store = handle.store.lock().await;
            store.projection.require_step(&step)?;
            if let Some(effect) = store.projection.effects.get(&effect_id) {
                ensure!(
                    effect.name == name && effect.input["arguments"] == params["arguments"],
                    "effect id reused with different arguments"
                );
                ensure!(
                    effect.outcome.is_some(),
                    "effect still running; duplicate dispatch rejected"
                );
                return Ok(effect.output.clone());
            }
            let registration = store
                .projection
                .step
                .as_ref()
                .unwrap()
                .registrations
                .iter()
                .find(|r| r.kind == "tool" && r.name == name)
                .cloned()
                .context("tool missing from step snapshot")?;
            let call = params["call"].as_str().map(String::from);
            if let Some(call) = &call {
                ensure!(
                    store.projection.pending_tools.contains(call),
                    "tool call not issued by model"
                );
                ensure!(
                    !store
                        .projection
                        .effects
                        .values()
                        .any(|e| e.step == step && e.input["call"].as_str() == Some(call)),
                    "tool call already dispatched"
                );
            }
            (registration, call)
        };
        let cancel = handle.cancel.lock().await.clone();
        if registration.tool.as_ref().is_some_and(|tool| tool.approval) {
            let approval_id = format!("approval:{effect_id}");
            self.commit(
                session,
                Fact::ApprovalRequested {
                    id: approval_id.clone(),
                    run: run.clone(),
                    name: name.clone(),
                    input: params["arguments"].clone(),
                },
            )
            .await?;
            if self.auto_approve {
                self.approval(session, &approval_id, true).await?;
            }
            loop {
                // `changed` avoids polling: an approval fact wakes this task and
                // makes the user's decision part of the same durable history.
                let changed = handle.changed.notified();
                let decision =
                    handle.store.lock().await.projection.approvals[&approval_id].approved;
                match decision {
                    Some(true) => break,
                    Some(false) => {
                        return Ok(json!({"error":"permission denied","outcome":"not_started"}));
                    }
                    None => {}
                }
                tokio::select! { () = changed => {}, () = cancel.cancelled() => bail!("approval cancelled") }
            }
        }
        ensure!(!cancel.is_cancelled(), "tool cancelled before dispatch");
        self.commit(
            session,
            Fact::EffectStarted {
                id: effect_id.clone(),
                run,
                step,
                kind: "tool".into(),
                name: name.clone(),
                input: json!({"arguments":params["arguments"],"call":call}),
            },
        )
        .await?;
        let execution = async {
            if registration.plugin == "morrow.builtin" {
                native_tool(&self.workspace, &name, &params["arguments"]).await
            } else {
                peer.call("registration.invoke", json!({"registration":registration,"context":params,"input":params["arguments"]})).await
            }
        };
        let result = tokio::select! { value = execution => value, () = cancel.cancelled() => bail!("tool cancelled; outcome unknown") };
        let (outcome, output) = match result {
            Ok(value) => (Outcome::Completed, value),
            Err(error) => (
                if peer.closed.is_cancelled() || error.to_string().contains("outcome unknown") {
                    Outcome::Unknown
                } else {
                    Outcome::Failed
                },
                json!({"error":error.to_string()}),
            ),
        };
        self.commit(
            session,
            Fact::EffectSettled {
                id: effect_id,
                outcome,
                output: output.clone(),
            },
        )
        .await?;
        Ok(output)
    }
}

fn model_error(error: &anyhow::Error) -> ModelError {
    error
        .downcast_ref::<ModelError>()
        .cloned()
        .unwrap_or(ModelError {
            code: "transport".into(),
            message: "Provider operation failed".into(),
            details: Value::Null,
        })
}
fn validate_model_result(result: &ModelResult, request: &PreparedRequest) -> Result<()> {
    let check = || -> Result<()> {
        ensure!(
            result.message.role == Role::Assistant,
            "provider must return assistant"
        );
        ensure!(
            !result.message.content.is_empty() || !result.message.tool_calls.is_empty(),
            "empty model result"
        );
        crate::projection::validate_messages(
            std::slice::from_ref(&result.message),
            request.purpose == "summary",
        )?;
        ensure!(
            serde_json::to_vec(result)?.len() <= 8_000_000,
            "model result too large"
        );
        if let Some(c) = &result.continuation {
            ensure!(
                c.provider == request.header.provider && !c.format.is_empty(),
                "invalid continuation owner"
            );
        }
        Ok(())
    };
    check().map_err(|_| {
        ModelError {
            code: "invalid_response".into(),
            message: "Provider returned an invalid model result".into(),
            details: Value::Null,
        }
        .into()
    })
}
async fn resolve(root: &Path, path: &str, write: bool) -> Result<PathBuf> {
    let joined = root.join(path);
    let resolved = if write && !joined.exists() {
        let parent = joined.parent().context("missing parent")?;
        tokio::fs::canonicalize(parent)
            .await?
            .join(joined.file_name().context("missing filename")?)
    } else {
        tokio::fs::canonicalize(joined).await?
    };
    ensure!(resolved.starts_with(root), "path is outside workspace");
    Ok(resolved)
}

async fn native_tool(root: &Path, name: &str, args: &Value) -> Result<Value> {
    match name {
        "read_file" => {
            let path = resolve(root, string(args, "path")?, false).await?;
            ensure!(
                tokio::fs::metadata(&path).await?.len() <= 1_000_000,
                "file exceeds 1 MB"
            );
            Ok(json!({"content":tokio::fs::read_to_string(path).await?}))
        }
        "list_files" => {
            let path = resolve(root, args["path"].as_str().unwrap_or("."), false).await?;
            let mut entries = tokio::fs::read_dir(path).await?;
            let mut files = vec![];
            while let Some(entry) = entries.next_entry().await? {
                ensure!(files.len() < 5000, "directory exceeds 5000 entries");
                let metadata = entry.metadata().await?;
                files.push(json!({"name":entry.file_name().to_string_lossy(),"directory":metadata.is_dir(),"bytes":metadata.len()}));
            }
            files.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_owned());
            Ok(json!({"files":files}))
        }
        "write_file" | "edit_file" => {
            let path = resolve(root, string(args, "path")?, true).await?;
            let content = if name == "edit_file" {
                let content = tokio::fs::read_to_string(&path).await?;
                let old = string(args, "old_text")?;
                ensure!(
                    !old.is_empty() && content.matches(old).count() == 1,
                    "edit requires exactly one matching occurrence"
                );
                content.replacen(old, string(args, "new_text")?, 1)
            } else {
                string(args, "content")?.into()
            };
            ensure!(content.len() <= 1_000_000, "write exceeds 1 MB");
            tokio::fs::write(path, content).await?;
            Ok(json!({"written":true}))
        }
        "shell" => {
            let timeout = args["timeout_seconds"].as_u64().unwrap_or(30).clamp(1, 300);
            let mut command = if cfg!(windows) {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C");
                c
            } else {
                let mut c = tokio::process::Command::new("sh");
                c.arg("-c");
                c
            };
            command
                .arg(string(args, "command")?)
                .current_dir(root)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            #[cfg(unix)]
            {
                command.process_group(0);
            }
            let mut child = command.spawn()?;
            let _group = ProcessGroup(child.id());
            let stdout = child.stdout.take().context("missing stdout")?;
            let stderr = child.stderr.take().context("missing stderr")?;
            let (status, stdout, stderr) =
                tokio::time::timeout(Duration::from_secs(timeout), async {
                    tokio::try_join!(child.wait(), read_output(stdout), read_output(stderr))
                })
                .await
                .context("shell timed out; outcome unknown")??;
            Ok(json!({"code":status.code(),"stdout":stdout,"stderr":stderr}))
        }
        _ => bail!("unknown builtin tool {name}"),
    }
}

async fn read_output(mut reader: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let length = reader.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        let remaining = 100_000_usize.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..length.min(remaining)]);
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

struct ProcessGroup(Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
