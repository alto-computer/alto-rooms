mod daemon;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(daemon::Daemon::default())
        .invoke_handler(tauri::generate_handler![daemon::connect, daemon::viewer_initial])
        .build(tauri::generate_context!())
        .expect("error while building Alto Rooms");

    // SIGINT/SIGTERM bypass RunEvent::Exit, which would orphan the sidecar; route them through it.
    let handle = app.handle().clone();
    if let Err(e) = ctrlc::set_handler(move || {
        handle.state::<daemon::Daemon>().kill_spawned();
        handle.exit(0);
    }) {
        eprintln!("could not install signal handler: {e}");
    }

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<daemon::Daemon>().kill_spawned();
        }
    });
}
