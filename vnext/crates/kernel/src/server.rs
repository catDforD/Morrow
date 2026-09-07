use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State, WebSocketUpgrade, ws::Message},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tower_http::services::ServeDir;

use crate::{
    rpc,
    runtime::{Runtime, string},
};

#[derive(Clone)]
pub struct ServerState {
    pub runtime: Arc<Runtime>,
    pub host_token: String,
    pub browser_token: String,
}

struct ApiError(anyhow::Error);
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":self.0.to_string()})),
        )
            .into_response()
    }
}
type ApiResult = Result<Json<Value>, ApiError>;

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value == format!("Bearer {token}"))
}
fn auth(headers: &HeaderMap, state: &ServerState) -> Result<(), ApiError> {
    if authorized(headers, &state.browser_token) {
        Ok(())
    } else {
        Err(ApiError(anyhow::anyhow!("unauthorized")))
    }
}

pub fn router(state: ServerState, web: std::path::PathBuf) -> Router {
    Router::new()
        .route("/host", get(host))
        .route("/events", get(events))
        .route("/api/sessions", get(sessions))
        .route("/api/session/{session}", get(snapshot).post(action))
        .route("/api/session/{session}/facts", get(facts))
        .route("/api/session/{session}/plugin/{hash}", get(client))
        .route("/api/session/{session}/request/{request}", get(request))
        .fallback_service(ServeDir::new(web).append_index_html_on_directories(true))
        .layer(DefaultBodyLimit::max(3_000_000))
        .with_state(state)
}

async fn host(
    State(state): State<ServerState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !authorized(&headers, &state.host_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade
        .max_message_size(16_000_000)
        .on_upgrade(move |socket| rpc::serve(socket, state.runtime))
}

async fn events(
    State(state): State<ServerState>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if query.get("token") != Some(&state.browser_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut events = state.runtime.events.subscribe();
    upgrade.on_upgrade(move |socket|async move {
        let (mut writer,mut reader) = socket.split();
        loop {
            tokio::select! {
                event = events.recv() => {
                    let value = match event { Ok(event) => event, Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => json!({"type":"resync"}), Err(_) => break };
                    if writer.send(Message::Text(value.to_string().into())).await.is_err() { break; }
                }
                message = reader.next() => if message.is_none() || matches!(message,Some(Ok(Message::Close(_))) | Some(Err(_))) { break; },
            }
        }
    })
}

async fn sessions(State(state): State<ServerState>, headers: HeaderMap) -> ApiResult {
    auth(&headers, &state)?;
    let directory = state.runtime.home.join("sessions");
    let mut sessions = vec![];
    if directory.exists() {
        for entry in std::fs::read_dir(directory).map_err(anyhow::Error::from)? {
            let entry = entry.map_err(anyhow::Error::from)?;
            if entry.path().extension().is_some_and(|e| e == "jsonl") {
                sessions.push(
                    entry
                        .path()
                        .file_stem()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    sessions.sort();
    Ok(Json(json!(sessions)))
}

async fn snapshot(
    State(state): State<ServerState>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    auth(&headers, &state)?;
    Ok(Json(
        json!({"session":state.runtime.snapshot(&session).await?,"workspace":state.runtime.snapshot("_workspace").await?}),
    ))
}
async fn facts(
    State(state): State<ServerState>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    auth(&headers, &state)?;
    Ok(Json(json!(
        state
            .runtime
            .session(&session)
            .await?
            .store
            .lock()
            .await
            .records
    )))
}
async fn request(
    State(state): State<ServerState>,
    Path((session, request)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    auth(&headers, &state)?;
    let projection = state.runtime.snapshot(&session).await?;
    let prepared = projection
        .requests
        .get(&request)
        .ok_or_else(|| anyhow::anyhow!("unknown request"))?;
    Ok(Json(
        json!({"prepared":prepared,"reconstructed":projection.reconstruct(prepared)?}),
    ))
}

async fn client(
    State(state): State<ServerState>,
    Path((session, hash)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    auth(&headers, &state)?;
    let projection = state.runtime.snapshot(&session).await?;
    let workspace = state.runtime.snapshot("_workspace").await?;
    let owner = if projection.plugins.contains_key(&hash) {
        &projection
    } else {
        &workspace
    };
    let version = owner
        .plugins
        .get(&hash)
        .ok_or_else(|| anyhow::anyhow!("unknown plugin"))?;
    let effective = projection
        .bindings
        .get(&version.manifest.name)
        .or_else(|| workspace.bindings.get(&version.manifest.name));
    require(
        owner.trusted.contains(&hash) && effective.is_some_and(|b| b.hash == hash && b.active),
        "plugin not trusted and active",
    )?;
    let source = version
        .manifest
        .client
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("plugin has no client entry"))?;
    Ok((
        [
            ("content-type", "text/javascript"),
            ("cache-control", "no-store"),
        ],
        source.clone(),
    )
        .into_response())
}

async fn action(
    State(state): State<ServerState>,
    Path(session): Path<String>,
    headers: HeaderMap,
    Json(params): Json<Value>,
) -> ApiResult {
    auth(&headers, &state)?;
    let runtime = &state.runtime;
    let action = string(&params, "action")?;
    let result = match action {
        "resume" => runtime.host().await?.call("session.resume",json!({"session":session})).await?,
        "submit" => { require(session != "_workspace", "reserved session")?; runtime.submit(&session,string(&params,"submission")?,string(&params,"text")?).await? }
        "cancel" => { runtime.cancel(&session).await?; Value::Null }
        "approve" => { runtime.approval(&session,string(&params,"id")?,params["approved"] == true).await?; Value::Null }
        "define" => runtime.define(&session,serde_json::from_value(params["manifest"].clone()).map_err(anyhow::Error::from)?).await?,
        "trust" => { runtime.trust(&session,string(&params,"hash")?).await?; Value::Null }
        "activate" | "stop" => { runtime.bind(&session,string(&params,"hash")?,action == "activate").await?; json!({"pending":true,"boundary":"next_step"}) }
        "promote" => {
            let snapshot = runtime.snapshot(&session).await?;
            let hash = string(&params,"hash")?;
            require(snapshot.trusted.contains(hash), "trust this exact version first")?;
            let version = &snapshot.plugins[hash];
            runtime.define("_workspace",version.manifest.clone()).await?;
            runtime.trust("_workspace",hash).await?;
            runtime.bind("_workspace",hash,true).await?;
            Value::Null
        }
        "invoke" => runtime.host().await?.call("client.invoke",json!({"session":session,"plugin":params["plugin"],"hash":params["hash"],"method":params["method"],"input":params["input"]})).await?,
        _ => return Err(anyhow::anyhow!("unknown action {action}").into()),
    };
    Ok(Json(result))
}

fn require(condition: bool, message: &str) -> Result<(), ApiError> {
    if condition {
        Ok(())
    } else {
        Err(anyhow::anyhow!("{message}").into())
    }
}
