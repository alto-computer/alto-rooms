use roomsd::{build_api_router, build_files_router, write_token, AppState};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let home = std::env::var("ROOMS_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join("rooms"));
    let (core, _watch) = rooms_core::watch::open_and_watch(&home).expect("open rooms home");
    let token = write_token(core.home()).expect("write token");
    let st = AppState { core, token, read_only: false, files_origin: "http://127.0.0.1:4318".into() };
    let api = build_api_router(st.clone()).into_make_service_with_connect_info::<SocketAddr>();
    // files router has no ConnectInfo extractor
    let files = build_files_router(st).into_make_service();
    let api_l = tokio::net::TcpListener::bind("127.0.0.1:4317").await.unwrap_or_else(|e| { eprintln!("port 4317: {e}"); std::process::exit(2) });
    let files_l = tokio::net::TcpListener::bind("127.0.0.1:4318").await.unwrap_or_else(|e| { eprintln!("port 4318: {e}"); std::process::exit(2) });
    eprintln!("roomsd: home={} api=http://127.0.0.1:4317 files=http://127.0.0.1:4318", home.display());
    let a = tokio::spawn(async move { axum::serve(api_l, api).await });
    let f = tokio::spawn(async move { axum::serve(files_l, files).await });
    let _ = tokio::join!(a, f);
}
