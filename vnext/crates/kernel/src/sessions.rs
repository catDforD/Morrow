use std::{
    collections::BTreeSet,
    fs::File,
    io::{BufRead, BufReader, ErrorKind},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;

use crate::store::{digest, valid_id};

fn directory(home: &Path, workspace: &Path) -> PathBuf {
    home.join("sessions")
        .join(digest(workspace.to_string_lossy().as_bytes()))
}

// Inspect ownership without opening a writer or recovering another project's log.
fn owner(path: &Path) -> Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line)?;
    if line.trim().is_empty() {
        return Ok(None);
    }
    let record: Value = serde_json::from_str(&line)
        .with_context(|| format!("invalid session header: {}", path.display()))?;
    ensure!(
        record["fact"]["type"] == "session_opened",
        "missing session ownership header: {}",
        path.display()
    );
    Ok(Some(
        record["fact"]["workspace"]
            .as_str()
            .context("missing session workspace")?
            .to_owned(),
    ))
}

pub(crate) fn path(home: &Path, workspace: &Path, name: &str) -> Result<PathBuf> {
    valid_id(name)?;
    if name == "_workspace" {
        let hash = digest(workspace.to_string_lossy().as_bytes());
        let current = home
            .join("sessions")
            .join(format!("workspace-v2-{hash}.jsonl"));
        let legacy = home
            .join("sessions")
            .join(format!("workspace-{hash}.jsonl"));
        return Ok(if !current.exists() && legacy.exists() {
            legacy
        } else {
            current
        });
    }
    let scoped = directory(home, workspace).join(format!("{name}.jsonl"));
    if scoped.exists() {
        return Ok(scoped);
    }
    let legacy = home.join("sessions").join(format!("{name}.jsonl"));
    // Keep old logs in place, but only reuse one when it belongs to this project.
    if owner(&legacy)?.is_some_and(|owner| Path::new(&owner) == workspace) {
        return Ok(legacy);
    }
    Ok(scoped)
}

fn internal(name: &str) -> bool {
    name == "_workspace"
        || name
            .strip_prefix("workspace-v2-")
            .or_else(|| name.strip_prefix("workspace-"))
            .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub(crate) fn names(home: &Path, workspace: &Path) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for directory in [home.join("sessions"), directory(home, workspace)] {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            let name = path
                .file_stem()
                .context("missing session name")?
                .to_string_lossy();
            if internal(&name) || valid_id(&name).is_err() {
                continue;
            }
            if owner(&path)?.is_some_and(|owner| Path::new(&owner) == workspace) {
                names.insert(name.into_owned());
            }
        }
    }
    Ok(names.into_iter().collect())
}
