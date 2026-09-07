use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{
    protocol::*,
    rpc::Peer,
    runtime::{Runtime, string},
};

impl Runtime {
    pub async fn model_call(
        &self,
        peer: &Arc<Peer>,
        session: &str,
        params: &Value,
    ) -> Result<Value> {
        let handle = self.session(session).await?;
        let request_id = string(params, "id")?.to_owned();
        let run = string(params, "run")?.to_owned();
        let step = string(params, "step")?.to_owned();
        let request = {
            let mut store = handle.store.lock().await;
            if store.projection.requests.contains_key(&request_id) {
                bail!("request id already used; effects are never automatically repeated");
            }
            let mut request = PreparedRequest {
                id: request_id.clone(),
                run: run.clone(),
                step: step.clone(),
                purpose: string(params, "purpose")?.into(),
                revision: store.projection.revision,
                surface: if params["surface"].is_array() {
                    serde_json::from_value(params["surface"].clone())?
                } else {
                    store.projection.surface.clone()
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
                body: Value::Null,
            };
            // Freeze and persist the complete provider body before opening the
            // network connection. This is the replayable audit boundary.
            request.body = store.projection.reconstruct(&request)?;
            let record = store.commit(Fact::RequestPrepared {
                request: request.clone(),
            })?;
            let _ = self
                .events
                .send(json!({"type":"fact","session":session,"record":record}));
            request
        };
        self.commit(
            session,
            Fact::EffectStarted {
                id: request_id.clone(),
                run,
                step,
                kind: "model".into(),
                name: request.header.provider.clone(),
                input: json!({"request":request_id}),
            },
        )
        .await?;
        let cancel = handle.cancel.lock().await.clone();
        let execution = async {
            if request.header.provider == "openai" {
                self.http_model(session, &request).await
            } else {
                let registration = request
                    .registrations
                    .iter()
                    .find(|r| r.kind == "model" && r.name == request.header.provider)
                    .context("model provider missing from snapshot")?;
                let output = peer
                    .call(
                        "registration.invoke",
                        json!({"registration":registration,"context":params,"input":request}),
                    )
                    .await?;
                Ok(serde_json::from_value(output)?)
            }
        };
        let result: Result<Message> = tokio::select! { result = execution => result, () = cancel.cancelled() => bail!("model cancelled; outcome unknown") };
        // Validate before accepting malformed provider output as a settled message.
        let result = result.and_then(|message| {
            ensure!(
                !message.content.is_empty() || !message.tool_calls.is_empty(),
                "empty model response"
            );
            ensure!(
                message.role == Role::Assistant,
                "provider returned a non-assistant message"
            );
            crate::projection::validate_messages(
                std::slice::from_ref(&message),
                request.purpose == "summary",
            )?;
            Ok(message)
        });
        let (outcome, output) = match &result {
            Ok(message) => (Outcome::Completed, json!(message)),
            Err(e) => (Outcome::Failed, json!({"error":e.to_string()})),
        };
        self.commit(
            session,
            Fact::EffectSettled {
                id: request_id.clone(),
                outcome,
                output,
            },
        )
        .await?;
        let (message, error) = match &result {
            Ok(message) => (Some(message.clone()), None),
            Err(e) => (None, Some(e.to_string())),
        };
        self.commit(
            session,
            Fact::ModelSettled {
                request: request_id,
                message,
                error,
            },
        )
        .await?;
        Ok(json!(result?))
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

    async fn http_model(&self, session: &str, request: &PreparedRequest) -> Result<Message> {
        ensure!(!self.api_key.is_empty(), "OPENAI_API_KEY is not configured");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(120))
            .build()?;
        let response = client
            .post(format!(
                "{}/chat/completions",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&self.api_key)
            .json(&request.body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("{}", e.without_url()))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // Providers can echo request headers; credentials never enter durable errors.
            let body = response
                .text()
                .await
                .unwrap_or_default()
                .replace(&self.api_key, "[redacted]");
            bail!(
                "model HTTP {status}: {}",
                body.chars().take(2000).collect::<String>()
            );
        }
        let mut stream = response.bytes_stream();
        let mut parser = Sse::default();
        while let Some(bytes) = stream.next().await {
            let bytes = bytes.map_err(|e| anyhow::anyhow!("{}", e.without_url()))?;
            for delta in parser.push(&bytes)? {
                let _ = self.events.send(
                    json!({"type":"delta","session":session,"request":request.id,"text":delta}),
                );
            }
            if parser.done {
                return parser.finish();
            }
        }
        bail!("model stream ended before completion")
    }
}

/// Adapts the existing model crate's framed SSE/fragmented tool-call approach to prepared bodies.
#[derive(Default)]
struct Sse {
    buffer: Vec<u8>,
    text: String,
    reasoning: String,
    calls: BTreeMap<usize, (String, String, String)>,
    done: bool,
}
impl Sse {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend(bytes);
        ensure!(self.buffer.len() <= 8_000_000, "SSE frame exceeds 8 MB");
        let mut deltas = vec![];
        while let Some((end, len)) = self.buffer.iter().enumerate().find_map(|(index, _)| {
            if self.buffer[index..].starts_with(b"\r\n\r\n") {
                Some((index, 4))
            } else if self.buffer[index..].starts_with(b"\n\n") {
                Some((index, 2))
            } else {
                None
            }
        }) {
            let frame = String::from_utf8(self.buffer.drain(..end + len).collect())?;
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if data.trim().is_empty() {
                continue;
            }
            if data.trim() == "[DONE]" {
                self.done = true;
                break;
            }
            let value: Value = serde_json::from_str(&data)?;
            let Some(choices) = value["choices"].as_array() else {
                bail!("invalid model SSE chunk");
            };
            for choice in choices {
                if choice["index"].as_u64().unwrap_or(0) != 0 {
                    continue;
                }
                let delta = &choice["delta"];
                if let Some(content) = delta["content"].as_str() {
                    self.text.push_str(content);
                    deltas.push(content.into());
                }
                if let Some(content) = delta["reasoning_content"].as_str() {
                    self.reasoning.push_str(content);
                }
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for call in calls {
                        let index =
                            call["index"].as_u64().context("missing tool call index")? as usize;
                        let entry = self.calls.entry(index).or_default();
                        if let Some(id) = call["id"].as_str() {
                            entry.0 = id.into();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            entry.1.push_str(name);
                        }
                        if let Some(arguments) = call["function"]["arguments"].as_str() {
                            entry.2.push_str(arguments);
                        }
                    }
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    ensure!(
                        reason == "stop" || reason == "tool_calls",
                        "incomplete model response: {reason}"
                    );
                    ensure!(
                        reason != "tool_calls" || !self.calls.is_empty(),
                        "empty tool call response"
                    );
                    self.done = true;
                }
            }
            if self.done {
                break;
            }
        }
        Ok(deltas)
    }
    fn finish(self) -> Result<Message> {
        ensure!(
            self.done && (!self.text.is_empty() || !self.calls.is_empty()),
            "empty model response"
        );
        let tool_calls = self
            .calls
            .into_values()
            .map(|(id, name, args)| {
                Ok(ToolCall {
                    id,
                    name,
                    arguments: serde_json::from_str(&args)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Message {
            role: Role::Assistant,
            content: self.text,
            reasoning: self.reasoning,
            tool_calls,
            tool_call_id: None,
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_utf8_sse_and_tool_arguments_are_accumulated_before_settlement() {
        let source = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\",\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"
        );
        let mut parser = Sse::default();
        for byte in source.as_bytes() {
            parser.push(&[*byte]).unwrap();
        }
        let message = parser.finish().unwrap();
        assert_eq!(message.content, "你好");
        assert_eq!(message.tool_calls[0].arguments, json!({"path":"a.txt"}));
    }

    #[test]
    fn truncated_or_length_limited_stream_does_not_become_a_completed_message() {
        let mut parser = Sse::default();
        parser.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n").unwrap();
        assert!(parser.finish().is_err());
        assert!(
            Sse::default()
                .push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n")
                .is_err()
        );
    }
}
