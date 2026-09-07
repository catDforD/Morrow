use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::runtime::Runtime;

type Reply = oneshot::Sender<Result<Value>>;

pub struct Peer {
    pub epoch: String,
    tx: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<String, Reply>>,
    pub closed: CancellationToken,
}

struct PendingGuard<'a> {
    peer: &'a Peer,
    id: String,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.peer.pending.lock().unwrap().remove(&self.id);
    }
}

impl Peer {
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _guard = PendingGuard {
            peer: self,
            id: id.clone(),
        };
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        tokio::select! {
            value = rx => value.map_err(|_| anyhow!("host disconnected"))?,
            () = self.closed.cancelled() => Err(anyhow!("host disconnected")),
        }
    }
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":params}))
    }
    fn send(&self, value: Value) -> Result<()> {
        self.tx
            .send(Message::Text(value.to_string().into()))
            .map_err(|_| anyhow!("host disconnected"))
    }
    pub fn disconnect(&self) {
        self.closed.cancel();
        self.pending.lock().unwrap().clear();
    }
}

pub async fn serve(socket: WebSocket, runtime: Arc<Runtime>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let peer = Arc::new(Peer {
        epoch: uuid::Uuid::new_v4().to_string(),
        tx,
        pending: Mutex::new(HashMap::new()),
        closed: CancellationToken::new(),
    });
    if runtime.attach(peer.clone()).await.is_err() {
        return;
    }
    let writer_peer = peer.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                () = writer_peer.closed.cancelled() => break,
                message = rx.recv() => match message { Some(message) => if sink.send(message).await.is_err() { break; }, None => break },
            }
        }
        writer_peer.disconnect();
    });
    while let Some(Ok(message)) =
        tokio::select! { message = stream.next() => message, () = peer.closed.cancelled() => None }
    {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            break;
        };
        if value["jsonrpc"] != "2.0" {
            break;
        }
        if let Some(method) = value["method"].as_str() {
            let method = method.to_owned();
            let runtime = runtime.clone();
            let peer = peer.clone();
            // Never await an inbound handler in the socket reader: handlers may call Node again.
            tokio::spawn(async move {
                let result = runtime
                    .host_rpc(&peer, &method, value["params"].clone())
                    .await;
                if !value["id"].is_null() {
                    let response = match result {
                        Ok(result) => json!({"jsonrpc":"2.0","id":value["id"],"result":result}),
                        Err(error) => {
                            json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32000,"message":error.to_string()}})
                        }
                    };
                    let _ = peer.send(response);
                }
            });
        } else if let Some(id) = value["id"].as_str()
            && let Some(tx) = peer.pending.lock().unwrap().remove(id)
        {
            let result = if value["error"].is_null() {
                Ok(value["result"].clone())
            } else {
                Err(anyhow!(
                    "{}",
                    value["error"]["message"]
                        .as_str()
                        .unwrap_or("host RPC failed")
                ))
            };
            let _ = tx.send(result);
        }
    }
    peer.disconnect();
    runtime.detach(&peer).await;
    writer.abort();
}
