mod daemon;
mod flush;

use flush::Intent;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

const MENU_NEW_TAB: &str = "new-tab";
const MENU_CLOSE_TAB: &str = "close-tab";
const MENU_CLOSE_WINDOW: &str = "close-window";
const MENU_QUIT: &str = "quit";

/// App menu (About, Hide, Quit ⌘Q), Edit (predefined, so text editing keys keep
/// working) and 파일 (새 탭 ⌘T, 탭 닫기 ⌘W, 창 닫기 ⇧⌘W). Quit is our own item, not
/// the predefined one, so it can flush notes before exiting.
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
    MenuBuilder::new(app).items(&[&app_menu, &edit_menu, &file_menu]).build()
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

    // SIGINT/SIGTERM bypass RunEvent::Exit, which would orphan the sidecar; route them through it.
    let handle = app.handle().clone();
    if let Err(e) = ctrlc::set_handler(move || {
        handle.state::<daemon::Daemon>().kill_spawned();
        handle.exit(0);
    }) {
        eprintln!("could not install signal handler: {e}");
    }

    // Every way out (window closed after the flush, menu Quit, Dock/Apple Event quit) ends here.
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<daemon::Daemon>().kill_spawned();
        }
    });
}
