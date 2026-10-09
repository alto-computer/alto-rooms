mod collector;
mod daemon;
mod drafts;
mod flush;
mod share;
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
const MENU_TOGGLE_ASK: &str = "toggle-ask";
const MENU_BACK: &str = "back";
const MENU_FORWARD: &str = "forward";
const MENU_REOPEN_TAB: &str = "reopen-tab";
const MENU_NEXT_TAB: &str = "next-tab";
const MENU_PREV_TAB: &str = "prev-tab";

/// App menu (About, Hide, Quit ⌘Q), Edit (predefined, so text editing keys keep
/// working), File (New Tab ⌘T, Close Tab ⌘W, Close Window ⇧⌘W) and View (Find ⌘K, Toggle Sidebar ⌘B, Back ⌘[, Forward ⌘]).
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
    let new_tab = MenuItemBuilder::with_id(MENU_NEW_TAB, "New Tab").accelerator("CmdOrCtrl+T").build(app)?;
    let close_tab = MenuItemBuilder::with_id(MENU_CLOSE_TAB, "Close Tab").accelerator("CmdOrCtrl+W").build(app)?;
    let reopen_tab = MenuItemBuilder::with_id(MENU_REOPEN_TAB, "Reopen Closed Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let close_window = MenuItemBuilder::with_id(MENU_CLOSE_WINDOW, "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&close_tab)
        .item(&reopen_tab)
        .separator()
        .item(&close_window)
        .build()?;
    let find = MenuItemBuilder::with_id(MENU_FIND, "Find").accelerator("CmdOrCtrl+K").build(app)?;
    let sidebar = MenuItemBuilder::with_id(MENU_TOGGLE_SIDEBAR, "Toggle Sidebar").accelerator("CmdOrCtrl+B").build(app)?;
    let ask = MenuItemBuilder::with_id(MENU_TOGGLE_ASK, "Ask Bar").accelerator("CmdOrCtrl+J").build(app)?;
    let back = MenuItemBuilder::with_id(MENU_BACK, "Back").accelerator("CmdOrCtrl+[").build(app)?;
    let forward = MenuItemBuilder::with_id(MENU_FORWARD, "Forward").accelerator("CmdOrCtrl+]").build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&find)
        .item(&sidebar)
        .item(&ask)
        .separator()
        .item(&back)
        .item(&forward)
        .build()?;
    let next_tab = MenuItemBuilder::with_id(MENU_NEXT_TAB, "Show Next Tab").accelerator("CmdOrCtrl+Shift+]").build(app)?;
    let prev_tab = MenuItemBuilder::with_id(MENU_PREV_TAB, "Show Previous Tab").accelerator("CmdOrCtrl+Shift+[").build(app)?;
    let window_menu = SubmenuBuilder::new(app, "Window").item(&next_tab).item(&prev_tab).build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit_menu, &file_menu, &view_menu, &window_menu]).build()
}

fn emit(app: &AppHandle, event: &str) {
    if let Err(e) = app.emit(event, ()) {
        eprintln!("could not emit {event}: {e}");
    }
}

type InvokeHandler = Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync>;

#[cfg(not(feature = "flush-probe"))]
fn invoke_handler() -> InvokeHandler {
    Box::new(tauri::generate_handler![
        daemon::connect,
        daemon::viewer_initial,
        flush::flush_done,
        drafts::save_note_draft,
        drafts::load_note_draft,
        drafts::delete_note_draft,
        share::doc_original,
        share::reveal_doc,
        share::open_doc
    ])
}

/// Verification builds also expose the quit-flush probe.
#[cfg(feature = "flush-probe")]
fn invoke_handler() -> InvokeHandler {
    Box::new(tauri::generate_handler![
        daemon::connect,
        daemon::viewer_initial,
        flush::flush_done,
        drafts::save_note_draft,
        drafts::load_note_draft,
        drafts::delete_note_draft,
        share::doc_original,
        share::reveal_doc,
        share::open_doc,
        flush::flush_probe,
        flush::flush_probe_armed
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(daemon::Daemon::default())
        .manage(collector::Collector::default())
        .manage(flush::Flush::default())
        .menu(build_menu)
        .setup(|app| {
            // Start roomsd while the webview loads; the first `connect` awaits this.
            app.state::<daemon::Daemon>().prewarm(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_NEW_TAB => emit(app, "menu://new-tab"),
            MENU_CLOSE_TAB => emit(app, "menu://close-tab"),
            MENU_FIND => emit(app, "menu://find"),
            MENU_TOGGLE_SIDEBAR => emit(app, "menu://toggle-sidebar"),
            MENU_TOGGLE_ASK => emit(app, "menu://toggle-ask"),
            MENU_BACK => emit(app, "menu://back"),
            MENU_FORWARD => emit(app, "menu://forward"),
            MENU_REOPEN_TAB => emit(app, "menu://reopen-tab"),
            MENU_NEXT_TAB => emit(app, "menu://next-tab"),
            MENU_PREV_TAB => emit(app, "menu://prev-tab"),
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
        .invoke_handler(invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building Alto Rooms");

    // Dock "Quit", `quit app` Apple Events and logout go through AppKit's terminate:, which
    // tao never reports as ExitRequested; hook it so they flush too.
    #[cfg(target_os = "macos")]
    terminate::install(app.handle());

    // SIGINT/SIGTERM would bypass RunEvent::Exit (orphaning the sidecar) and skip the note
    // flush; route them through a flush round like menu Quit (2.5 s cap, then exit).
    let handle = app.handle().clone();
    if let Err(e) = ctrlc::set_handler(move || {
        eprintln!("flush: SIGINT/SIGTERM received");
        flush::request(&handle, Intent::Exit);
    }) {
        eprintln!("could not install signal handler: {e}");
    }

    // Paths that flush notes first (one round through flush::FlushGate, 2.5 s fallback):
    // - window close: red button, File → Close Window (⇧⌘W)  — CloseRequested
    // - app menu Quit (⌘Q)                              — on_menu_event
    // - Dock "Quit", `quit app` Apple Event, logout      — applicationShouldTerminate: (terminate.rs)
    // - a code-less ExitRequested before any round      — below
    // - SIGINT/SIGTERM                                   — ctrlc handler above
    // Only SIGKILL skips the flush. Every exit except SIGKILL reaches RunEvent::Exit, which
    // stops the sidecars (roomsd: SIGTERM, 1 s grace, then SIGKILL; rooms-collect: killed).
    app.run(|handle, event| match event {
        // A code-less exit request (e.g. the last window was destroyed) is held until a round
        // has run; our own app.exit(n) (code Some) and the exit after a completed round pass.
        RunEvent::ExitRequested { code, api, .. } => {
            if flush::intercept_exit(handle, code) {
                api.prevent_exit();
            }
        }
        // Every way out except SIGKILL ends here, flushed or not: the sidecar always stops.
        RunEvent::Exit => {
            eprintln!("flush: exiting");
            handle.state::<collector::Collector>().kill();
            handle.state::<daemon::Daemon>().kill_spawned();
        }
        _ => {}
    });
}
