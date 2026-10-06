use roomsd::{acquire_home_lock, build_api_router, build_files_router, write_token, AppState, NetConfig};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let home = std::env::var("ROOMS_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join("rooms"));
    let net = NetConfig::from_env().unwrap_or_else(|e| { eprintln!("roomsd: {e}"); std::process::exit(2) });
    let (ap, fp) = (net.api_port, net.files_port);
    // Bind and lock BEFORE touching state.json or the token: a second daemon must exit 2 without
    // rewriting the first one's token (which would lock its clients out) or racing its state.
    let api_l = tokio::net::TcpListener::bind(format!("127.0.0.1:{ap}")).await.unwrap_or_else(|e| { eprintln!("port {ap}: {e}"); std::process::exit(2) });
    let files_l = tokio::net::TcpListener::bind(format!("127.0.0.1:{fp}")).await.unwrap_or_else(|e| { eprintln!("port {fp}: {e}"); std::process::exit(2) });
    let _lock = acquire_home_lock(&home).unwrap_or_else(|e| { eprintln!("roomsd: {}/.rooms/lock: {e}", home.display()); std::process::exit(2) });
    let (core, _watch) = rooms_core::watch::open_and_watch(&home).expect("open rooms home");
    // Plugins that ship with the desktop app (it passes their folder).
    if let Ok(dir) = std::env::var("ROOMS_BUNDLED_PLUGINS") {
        if let Err(e) = core.install_bundled_plugins(std::path::Path::new(&dir)) {
            eprintln!("roomsd: bundled plugins: {e}");
        }
    }
    let token = write_token(core.home()).expect("write token");
    // The login-shell PATH arrives in the background: startup never waits on the user's shell.
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    asks.resolve_login_path();
    let st = AppState { core, asks: asks.clone(), token, read_only: false, files_origin: format!("http://127.0.0.1:{fp}"), net };
    let api = build_api_router(st.clone()).into_make_service_with_connect_info::<SocketAddr>();
    // files router has no ConnectInfo extractor
    let files = build_files_router(st).into_make_service();
    eprintln!("roomsd: home={} api=http://127.0.0.1:{ap} files=http://127.0.0.1:{fp}", home.display());
    let a = tokio::spawn(async move { axum::serve(api_l, api).await });
    let f = tokio::spawn(async move { axum::serve(files_l, files).await });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    let (name, res) = tokio::select! {
        r = a => ("api", r),
        r = f => ("files", r),
        _ = term.recv() => { asks.shutdown().await; std::process::exit(0) }
        _ = tokio::signal::ctrl_c() => { asks.shutdown().await; std::process::exit(0) }
    };
    match res {
        Ok(Ok(())) => eprintln!("roomsd: {name} server stopped unexpectedly"),
        Ok(Err(e)) => eprintln!("roomsd: {name} server failed: {e}"),
        Err(e) => eprintln!("roomsd: {name} server task died: {e}"),
    }
    std::process::exit(1);
}
