use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use morrow_kernel::{
    protocol::*,
    runtime::{Runtime, id},
    server::{ServerState, router},
};
use serde_json::json;
use tokio::sync::{Mutex, Notify, broadcast};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    name = "morrow-next",
    version,
    about = "Fact-sourced agent with Cordis plugins"
)]
struct Args {
    #[arg(long, env = "MORROW_NEXT_HOME")]
    home: Option<PathBuf>,
    #[arg(long, default_value = ".")]
    workspace: PathBuf,
    #[arg(long, default_value = "default")]
    session: String,
    #[arg(long, env = "OPENAI_MODEL", default_value = "deepseek-chat")]
    model: String,
    #[arg(
        long,
        env = "OPENAI_BASE_URL",
        default_value = "https://api.deepseek.com/v1"
    )]
    base_url: String,
    #[arg(long, env = "MORROW_NEXT_RESOURCES")]
    resources: Option<PathBuf>,
    #[arg(long, env = "MORROW_NEXT_NODE", default_value = "node")]
    node: PathBuf,
    #[arg(long, help = "Explicitly approve all SDK tool effects in this process")]
    approve_all: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, default_value = "3001")]
        port: u16,
    },
    Run {
        prompt: String,
        #[arg(long)]
        submission: Option<String>,
    },
    History,
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
}
#[derive(Subcommand)]
enum PluginCommand {
    Define { manifest: PathBuf },
    Trust { hash: String },
    Activate { hash: String },
    Stop { hash: String },
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let home = args.home.unwrap_or_else(|| {
        PathBuf::from(
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".into()),
        )
        .join(".morrow-vnext")
    });
    let executable_dir = std::env::current_exe()?
        .parent()
        .context("missing executable directory")?
        .to_path_buf();
    let resources = args.resources.unwrap_or_else(|| {
        if executable_dir.join("packages/host/dist/index.js").exists() {
            executable_dir.clone()
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
        }
    });
    std::fs::create_dir_all(&home)?;
    let runtime = Arc::new(Runtime {
        home: home.canonicalize()?,
        workspace: args.workspace.canonicalize()?,
        model: args.model,
        base_url: args.base_url,
        api_key: std::env::var("OPENAI_API_KEY").unwrap_or_default(),
        sessions: Mutex::new(HashMap::new()),
        peer: Mutex::new(None),
        ready: Notify::new(),
        events: broadcast::channel(2048).0,
        shutdown: CancellationToken::new(),
        auto_approve: args.approve_all,
    });
    match args.command {
        Command::History => {
            println!(
                "{}",
                serde_json::to_string_pretty(&runtime.snapshot(&args.session).await?)?
            );
            return Ok(());
        }
        Command::Plugin { command } => {
            match command {
                PluginCommand::Define { manifest } => {
                    let manifest = serde_json::from_slice(&std::fs::read(manifest)?)?;
                    println!("{}", runtime.define(&args.session, manifest).await?);
                }
                PluginCommand::Trust { hash } => runtime.trust(&args.session, &hash).await?,
                PluginCommand::Activate { hash } => {
                    runtime.bind(&args.session, &hash, true).await?
                }
                PluginCommand::Stop { hash } => runtime.bind(&args.session, &hash, false).await?,
                PluginCommand::List => {
                    let state = runtime.snapshot(&args.session).await?;
                    println!(
                        "{}",
                        json!({"versions":state.plugins,"trusted":state.trusted,"bindings":state.bindings})
                    );
                }
            }
            return Ok(());
        }
        _ => {}
    }
    let host_entry = resources.join("packages/host/dist/index.js");
    ensure!(
        host_entry.exists(),
        "host bundle missing; run pnpm install && pnpm build in vnext/"
    );
    let port = match args.command {
        Command::Serve { port } => port,
        _ => 0,
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let host_token = id();
    let browser_token = id();
    let app = router(
        ServerState {
            runtime: runtime.clone(),
            host_token: host_token.clone(),
            browser_token: browser_token.clone(),
        },
        resources.join("packages/web/dist"),
    );
    let shutdown = runtime.shutdown.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
    });
    let child_runtime = runtime.clone();
    let bundled_node = executable_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let child_node = if args.node == std::path::Path::new("node") && bundled_node.exists() {
        bundled_node
    } else {
        args.node.clone()
    };
    let supervisor = tokio::spawn(async move {
        loop {
            let mut child = tokio::process::Command::new(&child_node)
                .arg(&host_entry)
                .env("MORROW_HOST_URL", format!("ws://{address}/host"))
                .env("MORROW_HOST_TOKEN", &host_token)
                .env("MORROW_NEXT_HOME", &child_runtime.home)
                .env_remove("OPENAI_API_KEY")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .kill_on_drop(true)
                .spawn()?;
            tokio::select! {
                () = child_runtime.shutdown.cancelled() => { child.kill().await.ok(); break; }
                status = child.wait() => { eprintln!("plugin host exited: {:?}",status?); }
                () = async {
                    loop {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let peer = child_runtime.peer.lock().await.clone();
                        if let Some(peer) = peer && peer.closed.is_cancelled() { break; }
                    }
                } => { child.kill().await.ok(); }
            }
            *child_runtime.peer.lock().await = None;
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Ok::<(), anyhow::Error>(())
    });
    tokio::time::timeout(Duration::from_secs(20), runtime.ready.notified())
        .await
        .context("plugin host failed to start")?;
    let result = match args.command {
        Command::Serve { .. } => {
            eprintln!("Morrow vNext: http://{address}/#token={browser_token}");
            // Structured readiness is also consumed by the deterministic and browser suites.
            println!(
                "{}",
                json!({"ready":true,"url":format!("http://{address}"),"token":browser_token})
            );
            tokio::signal::ctrl_c().await?;
            Ok(())
        }
        Command::Run { prompt, submission } => {
            let session = runtime.session(&args.session).await?;
            let mut events = runtime.events.subscribe();
            let submission = submission.unwrap_or_else(id);
            let mut printed = false;
            runtime.submit(&args.session, &submission, &prompt).await?;
            loop {
                let changed = session.changed.notified();
                let state = runtime.snapshot(&args.session).await?;
                if let Some(outcome) = state.last_outcome
                    && state.claimed.contains(&submission)
                    && state.run.is_none()
                {
                    if outcome != Outcome::Completed {
                        break Err(anyhow::anyhow!("run ended: {outcome:?}"));
                    }
                    if !printed
                        && let Some(message) =
                            state.surface.last().and_then(|id| state.nodes.get(id))
                    {
                        print!("{}", message.message.content);
                    }
                    println!();
                    break Ok(());
                }
                tokio::select! {
                    () = changed => {},
                    event = events.recv() => if let Ok(event) = event {
                        if event["type"] == "delta" { use std::io::Write; printed = true; print!("{}",event["text"].as_str().unwrap_or_default()); std::io::stdout().flush()?; }
                        if event["record"]["fact"]["type"] == "approval_requested" {
                            let fact = &event["record"]["fact"];
                            eprintln!("Approve {} {}? [y/N]",fact["name"],fact["input"]);
                            let answer = tokio::task::spawn_blocking(||{ let mut line=String::new(); std::io::stdin().read_line(&mut line).map(|_|line) }).await??;
                            runtime.approval(&args.session,fact["id"].as_str().unwrap(),answer.trim().eq_ignore_ascii_case("y")).await?;
                        }
                    },
                    _ = tokio::signal::ctrl_c() => { runtime.cancel(&args.session).await?; },
                }
            }
        }
        _ => unreachable!(),
    };
    runtime.shutdown.cancel();
    let _ = supervisor.await;
    server.abort();
    result
}
