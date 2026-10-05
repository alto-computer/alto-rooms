mod daemon;
mod flush;
#[cfg(target_os = "macos")]
mod terminate;

use flush::Intent;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

const MENU_NEW_TAB: &str = "new-tab";
const MENU_CLOSE_TAB: &str = "close-tab";
const MENU_CLOSE_WINDOW: &str = "close-window";
const MENU_QUIT: &str = "quit";
const MENU_FIND: &str = "find";
const MENU_TOGGLE_SIDEBAR: &str = "toggle-sidebar";

/// App menu (About, Hide, Quit ⌘Q), Edit (predefined, so text editing keys keep
/// working), 파일 (새 탭 ⌘T, 탭 닫기 ⌘W, 창 닫기 ⇧⌘W) and 보기 (찾기 ⌘K, 사이드바 ⌘B).
/// Quit is our own item, not the predefined one, so it can flush notes before
/// exiting. The webview applies its focus rule to every `menu://…` event.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "Quit Alto Rooms").accelerator("CmdOrCtrl+Q").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Alto Rooms")
        .about(None)
        .separator()
        .hide()
        .separator()
        .item(&quit)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let new_tab = MenuItemBuilder::with_id(MENU_NEW_TAB, "새 탭").accelerator("CmdOrCtrl+T").build(app)?;
    let close_tab = MenuItemBuilder::with_id(MENU_CLOSE_TAB, "탭 닫기").accelerator("CmdOrCtrl+W").build(app)?;
    let close_window = MenuItemBuilder::with_id(MENU_CLOSE_WINDOW, "창 닫기")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "파일")
        .item(&new_tab)
        .item(&close_tab)
        .separator()
        .item(&close_window)
        .build()?;
    let find = MenuItemBuilder::with_id(MENU_FIND, "찾기").accelerator("CmdOrCtrl+K").build(app)?;
    let sidebar = MenuItemBuilder::with_id(MENU_TOGGLE_SIDEBAR, "사이드바").accelerator("CmdOrCtrl+B").build(app)?;
    let view_menu = SubmenuBuilder::new(app, "보기").item(&find).item(&sidebar).build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit_menu, &file_menu, &view_menu]).build()
}

fn emit(app: &AppHandle, event: &str) {
    if let Err(e) = app.emit(event, ()) {
        eprintln!("could not emit {event}: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(daemon::Daemon::default())
        .manage(flush::Flush::default())
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_NEW_TAB => emit(app, "menu://new-tab"),
            MENU_CLOSE_TAB => emit(app, "menu://close-tab"),
            MENU_FIND => emit(app, "menu://find"),
            MENU_TOGGLE_SIDEBAR => emit(app, "menu://toggle-sidebar"),
            MENU_CLOSE_WINDOW => flush::request(app, Intent::CloseWindow),
            MENU_QUIT => flush::request(app, Intent::Exit),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == flush::MAIN_WINDOW {
                    api.prevent_close();
                    flush::request(window.app_handle(), Intent::CloseWindow);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![daemon::connect, daemon::viewer_initial, flush::flush_done])
        .build(tauri::generate_context!())
        .expect("error while building Alto Rooms");

    // Dock "Quit", `quit app` Apple Events and logout go through AppKit's terminate:, which
    // tao never reports as ExitRequested; hook it so they flush too.
    #[cfg(target_os = "macos")]
    terminate::install(app.handle());

    // SIGINT/SIGTERM bypass RunEvent::Exit, which would orphan the sidecar; route them through it.
    let handle = app.handle().clone();
    if let Err(e) = ctrlc::set_handler(move || {
        handle.state::<daemon::Daemon>().kill_spawned();
        handle.exit(0);
    }) {
        eprintln!("could not install signal handler: {e}");
    }

    // Paths that flush notes first (one round through flush::FlushGate, 2.5 s fallback):
    // - window close: red button, 파일 → 창 닫기 (⇧⌘W)  — CloseRequested
    // - app menu Quit (⌘Q)                              — on_menu_event
    // - Dock "Quit", `quit app` Apple Event, logout      — applicationShouldTerminate: (terminate.rs)
    // - a code-less ExitRequested before any round      — below
    // Paths that don't: SIGINT/SIGTERM (ctrlc handler above) and SIGKILL. Every exit except
    // SIGKILL reaches RunEvent::Exit, which kills the sidecar.
    app.run(|handle, event| match event {
        // A code-less exit request (e.g. the last window was destroyed) is held until a round
        // has run; our own app.exit(n) (code Some) and the exit after a completed round pass.
        RunEvent::ExitRequested { code, api, .. } => {
            if flush::intercept_exit(handle, code) {
                api.prevent_exit();
            }
        }
        // Every way out except SIGKILL ends here, flushed or not: the sidecar always dies.
        RunEvent::Exit => {
            eprintln!("flush: exiting");
            handle.state::<daemon::Daemon>().kill_spawned();
        }
        _ => {}
    });
}
