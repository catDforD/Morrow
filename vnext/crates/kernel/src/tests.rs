use crate::{projection::*, protocol::*, store::*};
use serde_json::json;
use std::path::PathBuf;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("morrow-facts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn store(directory: &Directory) -> SessionStore {
    SessionStore::open(&directory.0.join("session.jsonl"), &directory.0, None).unwrap()
}
fn start(store: &mut SessionStore) {
    store
        .commit(Fact::InputQueued {
            submission: "input".into(),
            message: Message::text(Role::User, "hello"),
        })
        .unwrap();
    store
        .commit(Fact::RunStarted {
            run: "run".into(),
            submission: "input".into(),
            epoch: "epoch".into(),
        })
        .unwrap();
    store
        .commit(Fact::StepStarted {
            run: "run".into(),
            step: "step".into(),
            registrations: vec![registration()],
        })
        .unwrap();
}
fn registration() -> Registration {
    Registration {
        kind: "model".into(),
        name: "script".into(),
        plugin: "test".into(),
        version: "1".into(),
        scope: "session".into(),
        epoch: "epoch".into(),
        generation: 0,
        tool: None,
    }
}
fn result(message: Message) -> ModelResult {
    ModelResult {
        message,
        continuation: None,
        usage: serde_json::Value::Null,
        finish_reason: "stop".into(),
    }
}
fn prepared(store: &mut SessionStore, id: &str) -> PreparedRequest {
    let mut request = PreparedRequest {
        id: id.into(),
        run: "run".into(),
        step: "step".into(),
        purpose: "main".into(),
        revision: store.projection.revision,
        surface: store.projection.surface.clone(),
        temporary: vec![Message::text(Role::User, "temporary context")],
        header: RequestHeader {
            profile: None,
            provider: "script".into(),
            model: "test".into(),
            system: "effective header".into(),
            tools: vec![],
            parameters: json!({"temperature":0}),
        },
        registrations: vec![registration()],
        plan: None,
        retry_of: None,
    };
    store
        .commit(Fact::ModelRequested {
            request: request.clone(),
        })
        .unwrap();
    request.plan = Some(PreparedPlan {
        profile: None,
        format: "test.v1".into(),
        payload: store.projection.reconstruct(&request).unwrap(),
    });
    store
        .commit(Fact::RequestPrepared {
            request: request.clone(),
        })
        .unwrap();
    request
}
fn model(store: &mut SessionStore, message: Message) {
    prepared(store, "request");
    store
        .commit(Fact::EffectStarted {
            id: "request".into(),
            run: "run".into(),
            step: "step".into(),
            kind: "model".into(),
            name: "script".into(),
            input: json!({}),
        })
        .unwrap();
    store
        .commit(Fact::EffectSettled {
            id: "request".into(),
            outcome: Outcome::Completed,
            output: json!(result(message.clone())),
        })
        .unwrap();
    store
        .commit(Fact::ModelSettled {
            request: "request".into(),
            result: Some(result(message)),
            error: None,
        })
        .unwrap();
}
fn finish(store: &mut SessionStore) {
    store
        .commit(Fact::StepEnded {
            step: "step".into(),
        })
        .unwrap();
    store
        .commit(Fact::RunEnded {
            run: "run".into(),
            outcome: Outcome::Completed,
            reason: String::new(),
        })
        .unwrap();
}

#[test]
fn incremental_projection_equals_replay_and_prepared_input_is_reconstructible() {
    let directory = Directory::new();
    let mut session = store(&directory);
    start(&mut session);
    model(
        &mut session,
        Message::text(Role::Assistant, "settled output"),
    );
    finish(&mut session);
    session
        .commit(Fact::PluginEvent {
            namespace: "unknown.extension".into(),
            version: 42,
            name: "future-fact".into(),
            data: json!({"preserved":true}),
        })
        .unwrap();
    let expected = session.projection.clone();
    let records = session.records.clone();
    drop(session);
    let session = store(&directory);
    assert_eq!(session.projection, expected);
    assert_eq!(session.records, records);
    let request = &session.projection.requests["request"];
    assert_eq!(
        session.projection.reconstruct(request).unwrap(),
        request.plan.as_ref().unwrap().payload
    );
    assert_eq!(
        request.plan.as_ref().unwrap().payload["messages"][1]["content"],
        "temporary context"
    );
}

#[test]
fn parallel_tool_results_preserve_call_order_and_recovery_retains_committed_progress() {
    let directory = Directory::new();
    let mut session = store(&directory);
    start(&mut session);
    let mut message = Message::text(Role::Assistant, "");
    message.tool_calls = vec![
        ToolCall {
            id: "a".into(),
            name: "tool".into(),
            arguments: json!({}),
        },
        ToolCall {
            id: "b".into(),
            name: "tool".into(),
            arguments: json!({}),
        },
    ];
    model(&mut session, message);
    session
        .commit(Fact::ToolSettled {
            call: "b".into(),
            message: Message::tool("b", "completed B"),
        })
        .unwrap();
    assert_eq!(session.projection.surface.len(), 2);
    drop(session);
    let session = store(&directory);
    let messages = session
        .projection
        .messages(&session.projection.surface)
        .unwrap();
    assert_eq!(messages[2].tool_call_id.as_deref(), Some("a"));
    assert!(messages[2].content.contains("not started"));
    assert_eq!(messages[3].content, "completed B");
    assert_eq!(session.projection.last_outcome, Some(Outcome::Unknown));
    validate_messages(&messages, true).unwrap();
}

#[test]
fn recovery_distinguishes_prepared_from_started_and_never_repeats_effects() {
    for started in [false, true] {
        let directory = Directory::new();
        let mut session = store(&directory);
        start(&mut session);
        prepared(&mut session, "r");
        if started {
            session
                .commit(Fact::EffectStarted {
                    id: "r".into(),
                    run: "run".into(),
                    step: "step".into(),
                    kind: "model".into(),
                    name: "script".into(),
                    input: json!({}),
                })
                .unwrap();
        }
        drop(session);
        let session = store(&directory);
        assert!(session.projection.settled_requests.contains("r"));
        assert_eq!(
            session
                .projection
                .effects
                .get("r")
                .map(|e| e.outcome.clone()),
            if started {
                Some(Some(Outcome::Unknown))
            } else {
                None
            }
        );
        let seq = session.projection.seq;
        drop(session);
        assert_eq!(store(&directory).projection.seq, seq);
    }
}

#[test]
fn recovery_restores_continuation_with_message_and_compaction_excludes_it() {
    let directory = Directory::new();
    let mut session = store(&directory);
    start(&mut session);
    prepared(&mut session, "r");
    let result = ModelResult {
        message: Message::text(Role::Assistant, "hello"),
        continuation: Some(Continuation {
            provider: "script".into(),
            format: "opaque.v1".into(),
            data: json!({"items":["preserve"]}),
        }),
        usage: json!({}),
        finish_reason: "stop".into(),
    };
    session
        .commit(Fact::EffectStarted {
            id: "r".into(),
            run: "run".into(),
            step: "step".into(),
            kind: "model".into(),
            name: "script".into(),
            input: json!({}),
        })
        .unwrap();
    session
        .commit(Fact::EffectSettled {
            id: "r".into(),
            outcome: Outcome::Completed,
            output: json!(result),
        })
        .unwrap();
    drop(session);
    let mut session = store(&directory);
    assert_eq!(
        session.projection.nodes["r"].continuation,
        result.continuation
    );
    let mut request = session.projection.requests["r"].clone();
    request.surface = session.projection.surface.clone();
    assert_eq!(
        session.projection.reconstruct(&request).unwrap()["continuations"][1]["data"]["items"][0],
        "preserve"
    );
    let covers = session
        .projection
        .replacement_covers("input:input", "r")
        .unwrap();
    session
        .commit(Fact::SurfaceReplaced {
            revision: session.projection.revision,
            start: "input:input".into(),
            end: "r".into(),
            id: "summary".into(),
            message: Message::text(Role::User, "summary"),
            covers,
            source_request: None,
        })
        .unwrap();
    request.surface = session.projection.surface.clone();
    assert_eq!(
        session.projection.reconstruct(&request).unwrap()["continuations"],
        json!([null, null])
    );
    assert!(session.projection.nodes["r"].continuation.is_some());
}

#[test]
fn requested_only_recovers_and_changed_preparation_is_rejected() {
    let directory = Directory::new();
    let mut session = store(&directory);
    start(&mut session);
    let mut request = PreparedRequest {
        id: "r".into(),
        run: "run".into(),
        step: "step".into(),
        purpose: "main".into(),
        revision: session.projection.revision,
        surface: session.projection.surface.clone(),
        temporary: vec![],
        header: RequestHeader {
            profile: None,
            provider: "script".into(),
            model: "m".into(),
            system: String::new(),
            tools: vec![],
            parameters: json!({"new_protocol_option":true}),
        },
        registrations: vec![registration()],
        plan: None,
        retry_of: None,
    };
    session
        .commit(Fact::ModelRequested {
            request: request.clone(),
        })
        .unwrap();
    assert!(
        session
            .commit(Fact::ModelRequested {
                request: request.clone()
            })
            .is_err()
    );
    request.header.model = "changed".into();
    request.plan = Some(PreparedPlan {
        profile: None,
        format: "test".into(),
        payload: json!({}),
    });
    assert!(session.commit(Fact::RequestPrepared { request }).is_err());
    drop(session);
    let session = store(&directory);
    assert!(session.projection.settled_requests.contains("r"));
    assert!(session.projection.effects.is_empty());
    assert!(session.projection.run.is_none());
}

#[test]
fn context_replacements_preserve_transitive_provenance_and_reject_stale_revision() {
    let directory = Directory::new();
    let mut session = store(&directory);
    for (id, content) in [("a", "a"), ("b", "b"), ("c", "c")] {
        session
            .commit(Fact::ContextAppended {
                id: id.into(),
                message: Message::text(Role::User, content),
            })
            .unwrap();
    }
    let replace =
        |revision, id: &str, start: &str, end: &str, covers: Vec<String>| Fact::SurfaceReplaced {
            source_request: None,
            revision,
            id: id.into(),
            start: start.into(),
            end: end.into(),
            message: Message::text(Role::User, "summary"),
            covers,
        };
    session
        .commit(replace(3, "ab", "a", "b", vec!["a".into(), "b".into()]))
        .unwrap();
    assert!(
        session
            .commit(replace(3, "abc", "ab", "c", vec![]))
            .is_err()
    );
    let covers = session.projection.replacement_covers("ab", "c").unwrap();
    assert_eq!(covers, vec!["a", "ab", "b", "c"]);
    session
        .commit(replace(4, "abc", "ab", "c", covers))
        .unwrap();
    assert_eq!(session.projection.nodes.len(), 5);
    assert_eq!(session.projection.surface, vec!["abc"]);
}

#[test]
fn torn_tail_is_quarantined_but_committed_corruption_is_rejected() {
    use std::io::Write;
    let directory = Directory::new();
    let session = store(&directory);
    let seq = session.projection.seq;
    drop(session);
    let file = directory.0.join("session.jsonl");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"{\"partial\":")
        .unwrap();
    let session = store(&directory);
    assert_eq!(session.projection.seq, seq);
    drop(session);
    assert!(
        std::fs::read_dir(&directory.0).unwrap().any(|e| e
            .unwrap()
            .path()
            .to_string_lossy()
            .contains("torn-"))
    );
    let bytes = std::fs::read_to_string(&file)
        .unwrap()
        .replace("session_opened", "session_closed");
    std::fs::write(&file, bytes).unwrap();
    assert!(SessionStore::open(&file, &directory.0, None).is_err());
}

#[test]
fn duplicate_inputs_stale_epochs_and_split_tool_groups_are_rejected() {
    let directory = Directory::new();
    let mut session = store(&directory);
    start(&mut session);
    assert!(
        session
            .commit(Fact::InputQueued {
                submission: "input".into(),
                message: Message::text(Role::User, "again")
            })
            .is_err()
    );
    let call = ToolCall {
        id: "call".into(),
        name: "tool".into(),
        arguments: json!({}),
    };
    let mut assistant = Message::text(Role::Assistant, "");
    assistant.tool_calls.push(call);
    model(&mut session, assistant);
    assert!(
        session
            .commit(Fact::SurfaceReplaced {
                source_request: None,
                revision: session.projection.revision,
                start: "request".into(),
                end: "request".into(),
                id: "replacement".into(),
                message: Message::text(Role::User, "bad summary"),
                covers: vec!["request".into()]
            })
            .is_err()
    );
    assert!(
        session
            .commit(Fact::StepEnded {
                step: "step".into()
            })
            .is_err()
    );
}
