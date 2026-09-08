use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 2;

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
    #[serde(default)]
    #[ts(optional)]
    pub profile: Option<String>,
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
    // Option 表示“可能还没有”：请求先落盘，Node 准备成功后才变成 Some(plan)。
    pub plan: Option<PreparedPlan>,
    #[serde(default)]
    pub retry_of: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreparedPlan {
    pub format: String,
    // Value 是任意 JSON。Rust 保存它，但不解释某家模型 API 的字段。
    pub payload: Value,
    #[serde(default)]
    #[ts(optional)]
    pub profile: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Continuation {
    pub provider: String,
    pub format: String,
    // provider 专属的续接数据（例如加密 reasoning），不是可展示的聊天正文。
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelInput {
    pub header: RequestHeader,
    pub messages: Vec<Message>,
    pub continuations: Vec<Option<Continuation>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelResult {
    pub message: Message,
    #[serde(default)]
    pub continuation: Option<Continuation>,
    #[serde(default)]
    pub usage: Value,
    pub finish_reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Value,
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ModelError {}

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
    SessionImported {
        source: String,
        seq: u32,
        hash: String,
        nodes: std::collections::BTreeMap<String, crate::projection::Node>,
        surface: Vec<String>,
    },
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
    ModelRequested {
        request: PreparedRequest,
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
        result: Option<ModelResult>,
        error: Option<ModelError>,
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
