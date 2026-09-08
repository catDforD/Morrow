use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use morrow_kernel::{
    runtime::{Runtime, id},
    server::{ServerState, router},
};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, Notify, broadcast},
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    name = "morrow-kernel",
    version,
    about = "Private fact kernel; start the application with the Node launcher"
)]
struct Args {
    #[arg(long)]
    home: PathBuf,
    #[arg(long, default_value = ".")]
    workspace: PathBuf,
    #[arg(long, default_value = "default")]
    session: String,
    #[arg(long)]
    resources: Option<PathBuf>,
    #[arg(long)]
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
    History,
    Migrate {
        target: String,
    },
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
    std::fs::create_dir_all(&args.home)?;
    let resources = args
        .resources
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let runtime = Arc::new(Runtime {
        home: args.home.canonicalize()?,
        workspace: args.workspace.canonicalize()?,
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
        Command::Migrate { target } => {
            println!("{}", runtime.migrate(&args.session, &target).await?);
            return Ok(());
        }
        Command::Plugin { command } => {
            match command {
                PluginCommand::Define { manifest } => println!(
                    "{}",
                    runtime
                        .define(
                            &args.session,
                            serde_json::from_slice(&std::fs::read(manifest)?)?
                        )
                        .await?
                ),
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
        Command::Serve { .. } => {}
    }
    let Command::Serve { port } = args.command else {
        unreachable!()
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
    // stdout is a private bootstrap pipe consumed by the Node parent.
    println!(
        "{}",
        json!({"kernel_listening":true,"url":format!("http://{address}"),"host_token":host_token,"token":browser_token})
    );
    let parent_closed = async {
        let mut bytes = Vec::new();
        tokio::io::stdin().read_to_end(&mut bytes).await
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = parent_closed => {},
        _ = runtime.shutdown.cancelled() => {},
    }
    let sessions: Vec<_> = runtime.sessions.lock().await.values().cloned().collect();
    for session in &sessions {
        session.cancel.lock().await.cancel();
    }
    let settle = async {
        loop {
            let mut active = false;
            for session in &sessions {
                let store = session.store.lock().await;
                active |= store.projection.run.is_some() && !store.projection.legacy;
            }
            if !active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(6), settle).await;
    runtime.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .context("server shutdown timed out")???;
    Ok(())
}
