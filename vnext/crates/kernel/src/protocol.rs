use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn text(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            reasoning: String::new(),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
    pub fn tool(id: &str, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(id.into()),
            ..Self::text(Role::Tool, content)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub approval: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Registration {
    pub kind: String,
    pub name: String,
    pub plugin: String,
    pub version: String,
    pub scope: String,
    pub epoch: String,
    pub generation: u32,
    pub tool: Option<ToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RequestHeader {
    pub provider: String,
    pub model: String,
    pub system: String,
    pub tools: Vec<ToolDefinition>,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreparedRequest {
    pub id: String,
    pub run: String,
    pub step: String,
    pub purpose: String,
    pub revision: u32,
    pub surface: Vec<String>,
    pub temporary: Vec<Message>,
    pub header: RequestHeader,
    pub registrations: Vec<Registration>,
    /// Exact provider body. Credentials and transport configuration live outside this record.
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
    NotStarted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PluginManifest {
    pub name: String,
    pub description: String,
    pub host: String,
    pub client: Option<String>,
    /// Locked, bundled dependencies: no install scripts execute during activation.
    pub dependency_lock: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PluginVersion {
    pub hash: String,
    pub manifest: PluginManifest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Fact {
    SessionOpened {
        workspace: String,
        parent: Option<String>,
    },
    InputQueued {
        submission: String,
        message: Message,
    },
    RunStarted {
        run: String,
        submission: String,
        epoch: String,
    },
    StepStarted {
        run: String,
        step: String,
        registrations: Vec<Registration>,
    },
    StepEnded {
        step: String,
    },
    RequestPrepared {
        request: PreparedRequest,
    },
    EffectStarted {
        id: String,
        run: String,
        step: String,
        kind: String,
        name: String,
        input: Value,
    },
    EffectSettled {
        id: String,
        outcome: Outcome,
        output: Value,
    },
    ModelSettled {
        request: String,
        message: Option<Message>,
        error: Option<String>,
    },
    ToolSettled {
        call: String,
        message: Message,
    },
    ApprovalRequested {
        id: String,
        run: String,
        name: String,
        input: Value,
    },
    ApprovalDecided {
        id: String,
        approved: bool,
    },
    ContextAppended {
        id: String,
        message: Message,
    },
    SurfaceReplaced {
        revision: u32,
        start: String,
        end: String,
        id: String,
        message: Message,
        covers: Vec<String>,
        source_request: Option<String>,
    },
    RunEnded {
        run: String,
        outcome: Outcome,
        reason: String,
    },
    PluginDefined {
        version: PluginVersion,
    },
    PluginTrusted {
        hash: String,
    },
    PluginBound {
        name: String,
        hash: String,
        active: bool,
    },
    PluginStateSet {
        namespace: String,
        key: String,
        value: Value,
    },
    PluginStateDeleted {
        namespace: String,
        key: String,
    },
    PluginEvent {
        namespace: String,
        version: u32,
        name: String,
        data: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Record {
    pub protocol: u32,
    pub seq: u32,
    pub previous: String,
    pub fact: Fact,
    pub hash: String,
}

pub fn provider_body(header: &RequestHeader, messages: &[Message]) -> Value {
    use serde_json::json;
    let mut wire_messages = vec![];
    if !header.system.is_empty() {
        wire_messages.push(json!({"role":"system", "content":header.system}));
    }
    for message in messages {
        let mut wire = json!({"role":message.role,"content":message.content});
        if !message.reasoning.is_empty() {
            wire["reasoning_content"] = json!(message.reasoning);
        }
        if !message.tool_calls.is_empty() {
            wire["tool_calls"] = json!(message.tool_calls.iter().map(|call| json!({
                "id":call.id, "type":"function", "function":{"name":call.name,"arguments":call.arguments.to_string()}
            })).collect::<Vec<_>>());
        }
        if let Some(id) = &message.tool_call_id {
            wire["tool_call_id"] = json!(id);
        }
        wire_messages.push(wire);
    }
    let mut body = header.parameters.clone();
    body["model"] = json!(header.model);
    body["messages"] = json!(wire_messages);
    body["stream"] = json!(true);
    if !header.tools.is_empty() {
        body["tools"] = json!(
            header
                .tools
                .iter()
                .map(|tool| json!({"type":"function","function":{
                    "name":tool.name,"description":tool.description,"parameters":tool.parameters
                }}))
                .collect::<Vec<_>>()
        );
    }
    body
}
