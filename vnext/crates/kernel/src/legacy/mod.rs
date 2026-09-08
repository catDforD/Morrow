//! Frozen v1 decoding and reducer. Never use this codec for new model requests.
#[allow(dead_code)]
mod projection;
#[allow(dead_code)]
mod protocol;

use crate::store::digest;
use anyhow::{Context, Result, ensure};
use projection::Projection;
use protocol::*;
use serde_json::{Value, json};

pub struct LegacyLog {
    pub records: Vec<Record>,
    pub projection: Projection,
}

impl LegacyLog {
    pub fn read(bytes: &[u8]) -> Result<Self> {
        // Read only complete records; the original file retains any torn suffix.
        let end = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .context("legacy log has no complete record")?
            + 1;
        let bytes = &bytes[..end];
        let mut log = Self {
            records: vec![],
            projection: Projection::default(),
        };
        for line in bytes.split(|b| *b == b'\n').filter(|b| !b.is_empty()) {
            let record: Record = serde_json::from_slice(line)?;
            let previous = log.records.last().map(|r| r.hash.as_str()).unwrap_or("");
            ensure!(
                record.protocol == 1 && record.seq == log.projection.seq + 1,
                "invalid legacy sequence"
            );
            ensure!(
                record.previous == previous
                    && record.hash
                        == digest(&serde_json::to_vec(&(
                            1u32,
                            record.seq,
                            previous,
                            &record.fact
                        ))?),
                "legacy checksum mismatch"
            );
            log.projection.apply(&record.fact)?;
            log.records.push(record);
        }
        Ok(log)
    }
    fn commit(&mut self, fact: Fact) -> Result<()> {
        self.projection.apply(&fact)?;
        Ok(())
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
                && let Ok(message) = serde_json::from_value::<Message>(effect.output.clone())
            {
                self.commit(Fact::ModelSettled {
                    request,
                    message: Some(message),
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
                message: None,
                error: Some(format!("{reason}: {status}")),
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

    pub fn normalized(&self) -> Result<crate::projection::Projection> {
        let mut value = serde_json::to_value(&self.projection)?;
        value["legacy"] = json!(true);
        for request in value["requests"]
            .as_object_mut()
            .context("missing legacy requests")?
            .values_mut()
        {
            request["plan"] = json!({"format":"legacy.chat.v1","payload":{"body":request["body"]}});
            request.as_object_mut().unwrap().remove("body");
        }
        Ok(serde_json::from_value(value)?)
    }
    pub fn audit(&self, id: &str) -> Result<Value> {
        let request = self
            .projection
            .requests
            .get(id)
            .context("unknown legacy request")?;
        Ok(
            json!({"protocol":1,"prepared":request,"reconstructed":self.projection.reconstruct(request)?}),
        )
    }
    pub fn recover_for_import(&mut self) -> Result<()> {
        self.finish_interrupted("imported from v1", Outcome::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_v1_fixture_checks_hashes_and_reconstructs_without_provider() {
        let bytes = include_bytes!("fixtures/v1.jsonl");
        let log = LegacyLog::read(bytes).unwrap();
        let state = log.normalized().unwrap();
        assert!(state.legacy);
        assert_eq!(state.nodes["q"].message.content, "legacy answer");
        assert_eq!(
            log.audit("q").unwrap()["reconstructed"],
            log.audit("q").unwrap()["prepared"]["body"]
        );
        let damaged = String::from_utf8(bytes.to_vec())
            .unwrap()
            .replace("legacy answer", "tampered");
        assert!(LegacyLog::read(damaged.as_bytes()).is_err());
    }
}
