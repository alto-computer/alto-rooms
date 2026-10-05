//! macOS: route `terminate:` (Dock "Quit", `quit app` Apple Events, logout and
//! shutdown) through the flush handshake.
//!
//! tao's app delegate has no `applicationShouldTerminate:`, so AppKit quits
//! right away and Tauri only sees `RunEvent::Exit` (no `ExitRequested`). We add
//! that method to tao's delegate class: it answers NSTerminateLater, runs a
//! flush round, and replies YES once the webview answers or the 2.5 s timeout
//! fires. Termination then proceeds normally (so `RunEvent::Exit` still kills
//! the sidecar, and a logout is not cancelled).

use std::ffi::CStr;
use std::sync::OnceLock;

use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::rc::Retained;
use objc2::{class, msg_send, sel};
use tauri::AppHandle;

use crate::flush::{self, TerminateReply};

const DELEGATE_CLASS: &CStr = c"TaoAppDelegateParent";
// NSApplicationTerminateReply (NSUInteger).
const NS_TERMINATE_NOW: usize = 1;
const NS_TERMINATE_LATER: usize = 2;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Runs the decision; a panic (which must never unwind into AppKit) answers
/// NSTerminateNow, so a bug can cost the flush but never block quitting.
fn guarded(decide: impl FnOnce() -> usize) -> usize {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(decide)).unwrap_or_else(|_| {
        eprintln!("terminate hook: panicked; quitting without a flush");
        NS_TERMINATE_NOW
    })
}

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    guarded(|| {
        let Some(app) = APP.get() else { return NS_TERMINATE_NOW };
        match flush::on_should_terminate(app) {
            TerminateReply::Now => NS_TERMINATE_NOW,
            TerminateReply::Later => NS_TERMINATE_LATER,
        }
    })
}

/// Adds `applicationShouldTerminate:` to tao's app delegate class. Call once,
/// after the app (and so tao's event loop and delegate) is built.
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(cls) = AnyClass::get(DELEGATE_CLASS) else {
        eprintln!("terminate hook: {DELEGATE_CLASS:?} not found; Dock/Apple Event quits won't flush");
        return;
    };
    let f: extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
    // SAFETY: the signature matches the type encoding "Q@:@" (NSUInteger return; self, _cmd, sender).
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(f);
        ffi::class_addMethod(
            cls as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("terminate hook: could not add applicationShouldTerminate:");
        return;
    }
    refresh_delegate(app);
}

/// AppKit caches which optional methods the delegate implements when the
/// delegate is set, so a method added afterwards may never be called. Setting
/// the delegate again (nil, then the same object) refreshes that cache. Runs on
/// the main thread once the event loop is up, when tao's delegate exists.
fn refresh_delegate(app: &AppHandle) {
    let res = app.run_on_main_thread(|| {
        // SAFETY: on the main thread; NSApp exists for the life of the app. `delegate`
        // is retained here for the duration, so clearing it briefly can't free it.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: Option<Retained<AnyObject>> = msg_send![ns_app, delegate];
            let Some(delegate) = delegate else {
                eprintln!("terminate hook: NSApp has no delegate; Dock/Apple Event quits won't flush");
                return;
            };
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![ns_app, setDelegate: nil];
            let _: () = msg_send![ns_app, setDelegate: &*delegate];
            let responds: Bool = msg_send![&*delegate, respondsToSelector: sel!(applicationShouldTerminate:)];
            eprintln!("terminate hook: installed (delegate responds: {})", responds.as_bool());
        }
    });
    if let Err(e) = res {
        eprintln!("terminate hook: could not refresh the app delegate: {e}");
    }
}

/// `[NSApp replyToApplicationShouldTerminate:YES]`, on the main thread.
pub fn reply(app: &AppHandle) {
    let res = app.run_on_main_thread(|| {
        // SAFETY: called on the main thread; NSApp exists for the life of the app.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::YES];
        }
    });
    if let Err(e) = res {
        eprintln!("terminate hook: could not reply: {e}");
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_while_deciding_answers_terminate_now() {
        assert_eq!(guarded(|| NS_TERMINATE_LATER), NS_TERMINATE_LATER);
        assert_eq!(guarded(|| panic!("flush state poisoned")), NS_TERMINATE_NOW);
    }
}
