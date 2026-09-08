use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::protocol::*;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct Projection {
    #[serde(default)]
    pub legacy: bool,
    pub seq: u32,
    pub workspace: String,
    pub parent: Option<String>,
    pub revision: u32,
    #[ts(type = "{ [key: string]: Node }")]
    pub nodes: BTreeMap<String, Node>,
    pub surface: Vec<String>,
    #[ts(type = "{ [key: string]: Message }")]
    pub inputs: BTreeMap<String, Message>,
    pub claimed: BTreeSet<String>,
    pub run_ids: BTreeSet<String>,
    pub step_ids: BTreeSet<String>,
    pub run: Option<Run>,
    pub step: Option<Step>,
    #[ts(type = "{ [key: string]: PreparedRequest }")]
    pub requests: BTreeMap<String, PreparedRequest>,
    pub settled_requests: BTreeSet<String>,
    #[ts(type = "{ [key: string]: Effect }")]
    pub effects: BTreeMap<String, Effect>,
    pub pending_tools: Vec<String>,
    #[ts(type = "{ [key: string]: string }")]
    pub tool_results: BTreeMap<String, String>,
    #[ts(type = "{ [key: string]: Approval }")]
    pub approvals: BTreeMap<String, Approval>,
    #[ts(type = "{ [key: string]: PluginVersion }")]
    pub plugins: BTreeMap<String, PluginVersion>,
    pub trusted: BTreeSet<String>,
    #[ts(type = "{ [key: string]: Binding }")]
    pub bindings: BTreeMap<String, Binding>,
    #[ts(type = "{ [namespace: string]: { [key: string]: JsonValue } }")]
    pub plugin_state: BTreeMap<String, BTreeMap<String, Value>>,
    pub last_outcome: Option<Outcome>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Node {
    pub message: Message,
    #[serde(default)]
    pub continuation: Option<Continuation>,
    pub covers: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Run {
    pub id: String,
    pub submission: String,
    pub epoch: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Step {
    pub id: String,
    pub registrations: Vec<Registration>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Effect {
    pub run: String,
    pub step: String,
    pub kind: String,
    pub name: String,
    pub input: Value,
    pub outcome: Option<Outcome>,
    pub output: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Approval {
    pub run: String,
    pub name: String,
    pub input: Value,
    pub approved: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Binding {
    pub hash: String,
    pub active: bool,
}

/// A single reducer for durable replay and the live projection. Validation never mutates state.
impl Projection {
    pub fn messages(&self, ids: &[String]) -> Result<Vec<Message>> {
        ids.iter()
            .map(|id| {
                self.nodes
                    .get(id)
                    .map(|node| node.message.clone())
                    .ok_or_else(|| anyhow::anyhow!("unknown context node {id}"))
            })
            .collect()
    }

    pub fn reconstruct(&self, request: &PreparedRequest) -> Result<Value> {
        ensure!(
            request.header.parameters.is_object(),
            "model parameters must be an object"
        );
        // A request stores node IDs, not copied conversation text. Nodes survive
        // later compaction, so this can reproduce the exact historical request.
        let mut messages = self.messages(&request.surface)?;
        messages.extend(request.temporary.clone());
        validate_messages(&messages, true)?;
        let mut continuations: Vec<_> = request
            .surface
            .iter()
            .map(|id| self.nodes[id].continuation.clone())
            .collect();
        continuations.extend(request.temporary.iter().map(|_| None));
        Ok(serde_json::to_value(ModelInput {
            header: request.header.clone(),
            messages,
            continuations,
        })?)
    }

    pub fn require_run(&self, id: &str) -> Result<()> {
        ensure!(
            self.run.as_ref().is_some_and(|run| run.id == id),
            "stale or inactive run"
        );
        Ok(())
    }

    pub fn require_step(&self, id: &str) -> Result<()> {
        ensure!(
            self.step.as_ref().is_some_and(|step| step.id == id),
            "stale or inactive step"
        );
        Ok(())
    }

    fn new_node(&self, id: &str) -> Result<()> {
        ensure!(
            !id.is_empty() && !self.nodes.contains_key(id),
            "duplicate or empty node id"
        );
        Ok(())
    }

    pub fn replacement_range(
        &self,
        start: &str,
        end: &str,
    ) -> Result<std::ops::RangeInclusive<usize>> {
        let first = self
            .surface
            .iter()
            .position(|id| id == start)
            .ok_or_else(|| anyhow::anyhow!("missing start node"))?;
        let last = self
            .surface
            .iter()
            .position(|id| id == end)
            .ok_or_else(|| anyhow::anyhow!("missing end node"))?;
        ensure!(first <= last, "reversed context range");
        Ok(first..=last)
    }

    pub fn replacement_covers(&self, start: &str, end: &str) -> Result<Vec<String>> {
        let mut covers = BTreeSet::new();
        for id in &self.surface[self.replacement_range(start, end)?] {
            covers.insert(id.clone());
            covers.extend(self.nodes[id].covers.clone());
        }
        Ok(covers.into_iter().collect())
    }

    pub fn validate(&self, fact: &Fact) -> Result<()> {
        match fact {
            Fact::SessionImported {
                source,
                nodes,
                surface,
                ..
            } => {
                ensure!(
                    self.seq == 1 && self.nodes.is_empty() && !source.is_empty(),
                    "import must follow session open"
                );
                let messages: Vec<_> = surface
                    .iter()
                    .map(|id| {
                        nodes
                            .get(id)
                            .map(|n| n.message.clone())
                            .ok_or_else(|| anyhow::anyhow!("missing import node"))
                    })
                    .collect::<Result<_>>()?;
                validate_messages(&messages, true)?;
            }
            Fact::SessionOpened { workspace, .. } => ensure!(
                self.seq == 0 && !workspace.is_empty(),
                "session already opened"
            ),
            Fact::InputQueued {
                submission,
                message,
            } => {
                ensure!(
                    !submission.is_empty() && !self.inputs.contains_key(submission),
                    "duplicate submission"
                );
                ensure!(message.role == Role::User, "input must be a user message");
                validate_messages(std::slice::from_ref(message), true)?;
                self.new_node(&format!("input:{submission}"))?;
            }
            Fact::RunStarted {
                run,
                submission,
                epoch,
            } => {
                ensure!(!self.run_ids.contains(run), "duplicate run id");
                ensure!(
                    self.run.is_none() && !run.is_empty() && !epoch.is_empty(),
                    "session already running"
                );
                ensure!(
                    self.inputs.contains_key(submission) && !self.claimed.contains(submission),
                    "input missing or already claimed"
                );
            }
            Fact::StepStarted {
                run,
                step,
                registrations,
            } => {
                ensure!(!self.step_ids.contains(step), "duplicate step id");
                self.require_run(run)?;
                ensure!(
                    self.step.is_none() && !step.is_empty(),
                    "step already running"
                );
                let mut names = BTreeSet::new();
                for registration in registrations {
                    ensure!(
                        registration.epoch == self.run.as_ref().unwrap().epoch,
                        "stale registration epoch"
                    );
                    ensure!(
                        names.insert((&registration.kind, &registration.name)),
                        "duplicate step registration"
                    );
                }
            }
            Fact::StepEnded { step } => {
                self.require_step(step)?;
                ensure!(
                    self.effects
                        .values()
                        .all(|e| e.step != *step || e.outcome.is_some()),
                    "step has running effects"
                );
                ensure!(
                    self.requests
                        .values()
                        .all(|r| r.step != *step || self.settled_requests.contains(&r.id)),
                    "step has unsettled requests"
                );
                ensure!(
                    self.pending_tools.is_empty(),
                    "step has missing tool results"
                );
            }
            Fact::ModelRequested { request } => {
                ensure!(
                    serde_json::to_vec(request)?.len() <= 8_000_000,
                    "model input exceeds 8 MB"
                );
                self.require_run(&request.run)?;
                self.require_step(&request.step)?;
                ensure!(
                    !self.requests.contains_key(&request.id),
                    "duplicate request"
                );
                ensure!(request.revision == self.revision, "stale surface revision");
                ensure!(
                    request.registrations == self.step.as_ref().unwrap().registrations,
                    "request must pin step registrations"
                );
                ensure!(
                    request.purpose == "main" || request.purpose == "summary",
                    "unsupported request purpose"
                );
                ensure!(
                    self.pending_tools.is_empty(),
                    "request before tool settlement"
                );
                ensure!(
                    self.requests
                        .values()
                        .all(|r| self.settled_requests.contains(&r.id)),
                    "request already in flight"
                );
                if request.purpose == "main" {
                    ensure!(
                        request.surface == self.surface,
                        "main request must use current surface"
                    );
                }
                if request.purpose == "summary" {
                    ensure!(
                        !request.surface.is_empty()
                            && self
                                .surface
                                .windows(request.surface.len())
                                .any(|ids| ids == request.surface),
                        "summary must select a contiguous surface range"
                    );
                }
                ensure!(
                    request.header.parameters.is_object(),
                    "model parameters must be an object"
                );
                for tool in &request.header.tools {
                    ensure!(
                        request
                            .registrations
                            .iter()
                            .any(|r| r.tool.as_ref() == Some(tool)),
                        "tool missing from step snapshot"
                    );
                }
                ensure!(request.plan.is_none(), "request already prepared");
                ensure!(
                    request
                        .registrations
                        .iter()
                        .any(|r| r.kind == "model" && r.name == request.header.provider),
                    "provider missing from step snapshot"
                );
                if let Some(prior) = &request.retry_of {
                    ensure!(
                        self.settled_requests.contains(prior),
                        "retry requires a settled request"
                    );
                }
                self.reconstruct(request)?;
            }
            Fact::RequestPrepared { request } => {
                self.require_run(&request.run)?;
                self.require_step(&request.step)?;
                ensure!(request.revision == self.revision, "stale surface revision");
                let mut original = request.clone();
                original.plan = None;
                ensure!(
                    self.requests.get(&request.id) == Some(&original),
                    "prepared source changed or already prepared"
                );
                ensure!(
                    !self.settled_requests.contains(&request.id),
                    "request already settled"
                );
                let plan = request
                    .plan
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("missing prepared plan"))?;
                ensure!(!plan.format.is_empty(), "missing plan format");
                ensure!(
                    serde_json::to_vec(plan)?.len() <= 8_000_000,
                    "plan too large"
                );
            }
            Fact::EffectStarted {
                id,
                run,
                step,
                kind,
                name,
                ..
            } => {
                self.require_run(run)?;
                self.require_step(step)?;
                ensure!(!self.effects.contains_key(id), "duplicate effect");
                if kind == "model" {
                    ensure!(
                        self.requests
                            .get(id)
                            .is_some_and(|r| r.run == *run && r.step == *step && r.plan.is_some()),
                        "model effect requires prepared request"
                    );
                    ensure!(
                        !self.settled_requests.contains(id),
                        "request already settled"
                    );
                }
                ensure!(!name.is_empty(), "empty effect name");
            }
            Fact::EffectSettled { id, .. } => ensure!(
                self.effects.get(id).is_some_and(|e| e.outcome.is_none()),
                "effect missing or already settled"
            ),
            Fact::ModelSettled {
                request,
                result,
                error,
            } => {
                let prepared = self
                    .requests
                    .get(request)
                    .ok_or_else(|| anyhow::anyhow!("missing request"))?;
                ensure!(
                    !self.settled_requests.contains(request),
                    "request already settled"
                );
                ensure!(
                    result.is_some() != error.is_some(),
                    "model settlement requires either message or error"
                );
                if let Some(result) = result {
                    let message = &result.message;
                    ensure!(
                        self.effects.get(request).is_some_and(
                            |e| e.output == serde_json::to_value(result).unwrap_or(Value::Null)
                        ),
                        "model result differs from settled effect"
                    );
                    ensure!(
                        !message.content.is_empty() || !message.tool_calls.is_empty(),
                        "empty model response"
                    );
                    if let Some(continuation) = &result.continuation {
                        ensure!(
                            continuation.provider == prepared.header.provider
                                && !continuation.format.is_empty(),
                            "invalid continuation owner"
                        );
                        ensure!(
                            serde_json::to_vec(continuation)?.len() <= 8_000_000,
                            "continuation too large"
                        );
                    }
                    ensure!(
                        self.effects
                            .get(request)
                            .is_some_and(|e| e.outcome == Some(Outcome::Completed)),
                        "model effect not completed"
                    );
                    ensure!(
                        message.role == Role::Assistant && message.tool_call_id.is_none(),
                        "model must produce an assistant message"
                    );
                    validate_messages(
                        std::slice::from_ref(message),
                        prepared.purpose == "summary",
                    )?;
                    self.new_node(request)?;
                }
            }
            Fact::ToolSettled { call, message } => {
                ensure!(
                    self.pending_tools.contains(call) && !self.tool_results.contains_key(call),
                    "unknown or duplicate tool result"
                );
                ensure!(
                    message.role == Role::Tool && message.tool_call_id.as_ref() == Some(call),
                    "tool result id mismatch"
                );
                ensure!(
                    message.tool_calls.is_empty(),
                    "tool result cannot call tools"
                );
                self.new_node(&self.tool_node_id(call))?;
            }
            Fact::ApprovalRequested { id, run, .. } => {
                self.require_run(run)?;
                ensure!(!self.approvals.contains_key(id), "duplicate approval");
            }
            Fact::ApprovalDecided { id, .. } => ensure!(
                self.approvals.get(id).is_some_and(|a| a.approved.is_none()),
                "approval missing or already decided"
            ),
            Fact::ContextAppended { id, message } => {
                self.new_node(id)?;
                ensure!(
                    self.pending_tools.is_empty(),
                    "context append during tool group"
                );
                validate_messages(std::slice::from_ref(message), true)?;
            }
            Fact::SurfaceReplaced {
                revision,
                start,
                end,
                id,
                message,
                covers,
                source_request,
            } => {
                ensure!(*revision == self.revision, "stale surface revision");
                ensure!(
                    self.pending_tools.is_empty(),
                    "cannot compact an open tool group"
                );
                self.new_node(id)?;
                let range = self.replacement_range(start, end)?;
                if let Some(request) = source_request {
                    let prepared = self
                        .requests
                        .get(request)
                        .ok_or_else(|| anyhow::anyhow!("summary request missing"))?;
                    ensure!(
                        prepared.purpose == "summary"
                            && self.settled_requests.contains(request)
                            && self.nodes.contains_key(request),
                        "summary request did not complete"
                    );
                    ensure!(
                        prepared.surface == self.surface[range.clone()],
                        "summary request covers a different range"
                    );
                }
                validate_messages(&self.messages(&self.surface[range.clone()])?, true)?;
                let mut surface = self.messages(&self.surface)?;
                surface.splice(range, [message.clone()]);
                validate_messages(&surface, true)?;
                ensure!(
                    *covers == self.replacement_covers(start, end)?,
                    "incomplete replacement provenance"
                );
            }
            Fact::RunEnded { run, .. } => {
                self.require_run(run)?;
                ensure!(
                    self.step.is_none() && self.pending_tools.is_empty(),
                    "run has open step"
                );
                ensure!(
                    self.effects
                        .values()
                        .all(|e| e.run != *run || e.outcome.is_some()),
                    "run has running effects"
                );
            }
            Fact::PluginDefined { version } => {
                ensure!(
                    !self.plugins.contains_key(&version.hash),
                    "plugin version already defined"
                );
                ensure!(!version.manifest.name.is_empty(), "empty plugin name");
            }
            Fact::PluginTrusted { hash } => {
                ensure!(self.plugins.contains_key(hash), "unknown plugin version")
            }
            Fact::PluginBound { name, hash, .. } => {
                ensure!(self.trusted.contains(hash), "plugin version not trusted");
                ensure!(
                    self.plugins
                        .get(hash)
                        .is_some_and(|p| p.manifest.name == *name),
                    "plugin name mismatch"
                );
            }
            Fact::PluginStateSet { namespace, key, .. }
            | Fact::PluginStateDeleted { namespace, key } => {
                ensure!(
                    !namespace.is_empty() && !key.is_empty(),
                    "empty plugin state namespace/key"
                );
            }
            Fact::PluginEvent {
                namespace,
                version,
                name,
                ..
            } => {
                ensure!(
                    namespace.contains('.') && *version > 0 && !name.is_empty(),
                    "custom facts must be namespaced and versioned"
                );
            }
        }
        Ok(())
    }

    pub fn apply(&mut self, fact: &Fact) -> Result<()> {
        self.validate(fact)?;
        self.apply_validated(fact);
        Ok(())
    }

    pub(crate) fn apply_validated(&mut self, fact: &Fact) {
        match fact {
            Fact::SessionImported { nodes, surface, .. } => {
                self.nodes = nodes.clone();
                self.surface = surface.clone();
                self.revision += 1;
            }
            Fact::SessionOpened { workspace, parent } => {
                self.workspace = workspace.clone();
                self.parent = parent.clone();
            }
            Fact::InputQueued {
                submission,
                message,
            } => {
                self.inputs.insert(submission.clone(), message.clone());
            }
            Fact::RunStarted {
                run,
                submission,
                epoch,
            } => {
                self.claimed.insert(submission.clone());
                self.run_ids.insert(run.clone());
                self.append(
                    format!("input:{submission}"),
                    self.inputs[submission].clone(),
                    vec![],
                );
                self.run = Some(Run {
                    id: run.clone(),
                    submission: submission.clone(),
                    epoch: epoch.clone(),
                });
                self.last_outcome = None;
            }
            Fact::StepStarted {
                step,
                registrations,
                ..
            } => {
                self.step = Some(Step {
                    id: step.clone(),
                    registrations: registrations.clone(),
                });
                self.step_ids.insert(step.clone());
            }
            Fact::StepEnded { .. } => {
                self.step = None;
            }
            Fact::ModelRequested { request } | Fact::RequestPrepared { request } => {
                self.requests.insert(request.id.clone(), request.clone());
            }
            Fact::EffectStarted {
                id,
                run,
                step,
                kind,
                name,
                input,
            } => {
                self.effects.insert(
                    id.clone(),
                    Effect {
                        run: run.clone(),
                        step: step.clone(),
                        kind: kind.clone(),
                        name: name.clone(),
                        input: input.clone(),
                        outcome: None,
                        output: Value::Null,
                    },
                );
            }
            Fact::EffectSettled {
                id,
                outcome,
                output,
            } => {
                let e = self.effects.get_mut(id).unwrap();
                e.outcome = Some(outcome.clone());
                e.output = output.clone();
            }
            Fact::ModelSettled {
                request, result, ..
            } => {
                self.settled_requests.insert(request.clone());
                if let Some(result) = result {
                    let message = &result.message;
                    if self.requests[request].purpose == "main" {
                        self.pending_tools = message
                            .tool_calls
                            .iter()
                            .map(|call| call.id.clone())
                            .collect();
                        self.append(request.clone(), message.clone(), vec![]);
                        self.nodes.get_mut(request).unwrap().continuation =
                            result.continuation.clone();
                    } else {
                        self.nodes.insert(
                            request.clone(),
                            Node {
                                message: message.clone(),
                                continuation: result.continuation.clone(),
                                covers: vec![],
                            },
                        );
                    }
                }
            }
            Fact::ToolSettled { call, message } => {
                let id = self.tool_node_id(call);
                self.nodes.insert(
                    id.clone(),
                    Node {
                        message: message.clone(),
                        continuation: None,
                        covers: vec![],
                    },
                );
                self.tool_results.insert(call.clone(), id);
                // Tools may finish concurrently, but model context must preserve
                // the order in which the model issued its calls.
                while let Some(call) = self.pending_tools.first() {
                    let Some(id) = self.tool_results.remove(call) else {
                        break;
                    };
                    self.surface.push(id);
                    self.pending_tools.remove(0);
                    self.revision += 1;
                }
            }
            Fact::ApprovalRequested {
                id,
                run,
                name,
                input,
            } => {
                self.approvals.insert(
                    id.clone(),
                    Approval {
                        run: run.clone(),
                        name: name.clone(),
                        input: input.clone(),
                        approved: None,
                    },
                );
            }
            Fact::ApprovalDecided { id, approved } => {
                self.approvals.get_mut(id).unwrap().approved = Some(*approved);
            }
            Fact::ContextAppended { id, message } => {
                self.append(id.clone(), message.clone(), vec![])
            }
            Fact::SurfaceReplaced {
                start,
                end,
                id,
                message,
                covers,
                ..
            } => {
                let range = self.replacement_range(start, end).unwrap();
                self.nodes.insert(
                    id.clone(),
                    Node {
                        message: message.clone(),
                        continuation: None,
                        covers: covers.clone(),
                    },
                );
                self.surface.splice(range, [id.clone()]);
                self.revision += 1;
            }
            Fact::RunEnded { outcome, .. } => {
                self.run = None;
                self.last_outcome = Some(outcome.clone());
            }
            Fact::PluginDefined { version } => {
                self.plugins.insert(version.hash.clone(), version.clone());
            }
            Fact::PluginTrusted { hash } => {
                self.trusted.insert(hash.clone());
            }
            Fact::PluginBound { name, hash, active } => {
                self.bindings.insert(
                    name.clone(),
                    Binding {
                        hash: hash.clone(),
                        active: *active,
                    },
                );
            }
            Fact::PluginStateSet {
                namespace,
                key,
                value,
            } => {
                self.plugin_state
                    .entry(namespace.clone())
                    .or_default()
                    .insert(key.clone(), value.clone());
            }
            Fact::PluginStateDeleted { namespace, key } => {
                if let Some(state) = self.plugin_state.get_mut(namespace) {
                    state.remove(key);
                }
            }
            Fact::PluginEvent { .. } => {}
        }
        self.seq += 1;
    }

    fn tool_node_id(&self, call: &str) -> String {
        format!(
            "tool:{}:{call}",
            self.step
                .as_ref()
                .map(|s| s.id.as_str())
                .unwrap_or("recovery")
        )
    }
    fn append(&mut self, id: String, message: Message, covers: Vec<String>) {
        self.nodes.insert(
            id.clone(),
            Node {
                message,
                covers,
                continuation: None,
            },
        );
        self.surface.push(id);
        self.revision += 1;
    }
}

pub fn validate_messages(messages: &[Message], complete: bool) -> Result<()> {
    let mut pending = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for message in messages {
        if message.role == Role::Tool {
            ensure!(
                message.tool_calls.is_empty(),
                "tool result cannot issue calls"
            );
            let id = message
                .tool_call_id
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("missing tool call id"))?;
            ensure!(pending.remove(id), "orphan or duplicate tool result");
            continue;
        }
        ensure!(
            pending.is_empty(),
            "unclosed tool calls before next message"
        );
        ensure!(
            message.tool_call_id.is_none(),
            "non-tool message has tool call id"
        );
        if message.tool_calls.is_empty() {
            continue;
        }
        ensure!(
            message.role == Role::Assistant,
            "only assistant may issue tool calls"
        );
        seen.clear();
        for call in &message.tool_calls {
            ensure!(
                !call.id.is_empty() && !call.name.is_empty() && seen.insert(&call.id),
                "duplicate or empty tool call"
            );
            pending.insert(&call.id);
        }
    }
    if complete && !pending.is_empty() {
        bail!("context ends with unresolved tool calls");
    }
    Ok(())
}
