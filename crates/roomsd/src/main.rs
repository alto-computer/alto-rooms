use rooms_core::asks::Asks;
use rooms_core::CoreError;
use rooms_protocol::layout;
use roomsd::{acquire_home_lock, build_api_router, build_files_router, resolve_mcp_bin, write_mcp_config, write_token, AppState, NetConfig};
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

/// Why roomsd could not start. Config, port and lock failures exit 2 so the desktop app can
/// tell "startup failed" (e.g. another daemon already runs) from a crash.
#[derive(Debug, thiserror::Error)]
enum StartupError {
    #[error("no home directory; set {}", layout::HOME_ENV)]
    NoHome,
    #[error("{0}")]
    Config(String),
    #[error("port {port}: {source}")]
    Bind { port: u16, source: io::Error },
    #[error("{}: {source}", .path.display())]
    Lock { path: PathBuf, source: io::Error },
    #[error("open rooms home: {0}")]
    OpenHome(#[from] CoreError),
    #[error("write token: {0}")]
    Token(io::Error),
    #[error("SIGTERM handler: {0}")]
    Signal(io::Error),
}

impl StartupError {
    fn exit_code(&self) -> i32 {
        match self {
            StartupError::Config(_) | StartupError::Bind { .. } | StartupError::Lock { .. } => 2,
            _ => 1,
        }
    }
}

#[tokio::main]
async fn main() {
    let code = match run().await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("roomsd: {e}");
            e.exit_code()
        }
    };
    // Exit explicitly: the watcher and ask threads must not hold the process open.
    std::process::exit(code);
}

/// Starts both listeners and serves until a signal (exit 0) or a listener stops (exit 1).
async fn run() -> Result<i32, StartupError> {
    let home = layout::home_from_env().ok_or(StartupError::NoHome)?;
    let net = NetConfig::from_env().map_err(StartupError::Config)?;
    let (ap, fp) = (net.api_port, net.files_port);
    // Bind and lock BEFORE touching state.json or the token: a second daemon must exit 2 without
    // rewriting the first one's token (which would lock its clients out) or racing its state.
    let api_l = bind(ap).await?;
    let files_l = bind(fp).await?;
    let _lock = acquire_home_lock(&home).map_err(|source| StartupError::Lock { path: layout::lock_path(&home), source })?;
    let (core, _watch) = rooms_core::watch::open_and_watch(&home)?;
    // Plugins that ship with the desktop app (it passes their folder).
    if let Ok(dir) = std::env::var("ROOMS_BUNDLED_PLUGINS") {
        if let Err(e) = core.install_bundled_plugins(std::path::Path::new(&dir)) {
            eprintln!("roomsd: bundled plugins: {e}");
        }
    }
    // Conversations come from rooms-collect's store; the desktop app passes its folder.
    if let Ok(dir) = std::env::var("ROOMS_COLLECT_DATA") {
        core.set_collect_data(std::path::Path::new(&dir));
    }
    // Lets asks give agents the rooms tools; no rooms-mcp next to us = no file = no MCP.
    let mcp_bin = resolve_mcp_bin(std::env::var("ROOMS_MCP_BIN").ok().as_deref(), std::env::current_exe().ok().as_deref());
    if let Err(e) = write_mcp_config(core.home(), mcp_bin.as_deref(), ap) { eprintln!("roomsd: mcp.json: {e}"); }
    let token = write_token(core.home()).map_err(StartupError::Token)?;
    // The login-shell PATH arrives in the background: startup never waits on the user's shell.
    let asks = Asks::new(core.clone(), None);
    asks.resolve_login_path();
    let st = AppState { core, asks: asks.clone(), token, read_only: false, files_origin: format!("http://127.0.0.1:{fp}"), net };
    let api = build_api_router(st.clone()).into_make_service_with_connect_info::<SocketAddr>();
    // files router has no ConnectInfo extractor
    let files = build_files_router(st).into_make_service();
    let mut term = signal(SignalKind::terminate()).map_err(StartupError::Signal)?;
    eprintln!("roomsd: home={} api=http://127.0.0.1:{ap} files=http://127.0.0.1:{fp}", home.display());
    let a = tokio::spawn(async move { axum::serve(api_l, api).await });
    let f = tokio::spawn(async move { axum::serve(files_l, files).await });
    let (name, res) = tokio::select! {
        r = a => ("api", r),
        r = f => ("files", r),
        _ = term.recv() => { asks.shutdown().await; return Ok(0) }
        _ = tokio::signal::ctrl_c() => { asks.shutdown().await; return Ok(0) }
    };
    match res {
        Ok(Ok(())) => eprintln!("roomsd: {name} server stopped unexpectedly"),
        Ok(Err(e)) => eprintln!("roomsd: {name} server failed: {e}"),
        Err(e) => eprintln!("roomsd: {name} server task died: {e}"),
    }
    Ok(1)
}

async fn bind(port: u16) -> Result<TcpListener, StartupError> {
    TcpListener::bind(format!("127.0.0.1:{port}")).await.map_err(|source| StartupError::Bind { port, source })
}
