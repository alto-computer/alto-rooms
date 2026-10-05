# Alto Rooms Plan 2 — Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a macOS desktop app (Tauri v2 + React) that shows the user's rooms as tabs, with:
- big live previews of agent HTML artifacts
- a Journal for each date, with editable `.md` notes
- a "지난 방문 이후" (since last visit) new-tab screen
- a ⌘K quick-find palette

The app talks to `roomsd` only through the Rooms Protocol.

**Architecture:**
- **`roomsd` (Plan 1 daemon).** Runs as a sidecar. The app starts it, or reuses one that is already running, and stops it on quit if the app started it.
- **Tauri Rust side.** Only three jobs: launching the daemon, reading the per-launch token file, and opening native dialogs or apps.
- **React UI (`apps/desktop/src`).** A pure protocol client built from three layers:
  - a framework-free `RoomsStore` that implements the snapshot + seq buffer rule;
  - a `ViewerStore` that holds tabs, last visits and the sidebar state in localStorage;
  - React views styled with Alto DS v3 tokens on shadcn/ui + Tailwind v4.
- **Testing.** The same UI also builds as a plain web app. Playwright drives it against a real `roomsd` started on test ports.

**Tech Stack:**
- Tauri 2 (CLI 2.12 via bun) with `tauri-plugin-shell` (sidecar), `tauri-plugin-dialog` and `tauri-plugin-opener`
- React 19, Vite, TypeScript strict
- Tailwind v4, shadcn/ui (sidebar, command, button, input, tooltip), lucide-react
- `@fontsource/jost`, `@fontsource/ibm-plex-mono`
- Vitest, Playwright
- Bun 1.4 workspaces

**Spec:** `docs/superpowers/specs/2026-10-05-alto-rooms-v1-spec.html`. Read §1 (US/AC-5…14), §3 (error copy), §4, §5 S3 (client rules) and §7 flows 1–3. The final design is the canvas "Alto Rooms 최종안" (https://claude.ai/artifact/FfR98TmrrEeqtLECUB5RHy). Its exact values are copied into this plan: §Design values below.

## Decisions made before this plan (user, 2026-10-05)

1. **roomsd lifecycle: the app runs it as a sidecar.**
   - If something already answers on the API port, the app reuses it.
   - When the app quits, it stops the daemon only if it started it.
   - Running roomsd as a launchd service is left for Plan 4.
2. **New tab shows "지난 방문 이후" only.** It is a grid of rooms with client-computed new-doc counts.
   - No inbox list or "넣기" (move) button. The inbox is opened like any other room.
   - "답 쓰는 중", room descriptions and "새 노선" are dropped because v1 has no data for them.
3. **Empty room hint:** show the room's folder path with a copy-on-click chip, instead of the design's `room add …` CLI chip.
4. **"찾기" (Find):** a ⌘K palette that filters room names and artifact titles on the client side. There is no server search.

## Global Constraints

- The app uses only `@alto-rooms/protocol-ts` to talk to roomsd. It never reads `~/rooms` files directly, except for the token file, which the Tauri Rust side reads.
- **Bearer token:**
  - Never put it in a URL, never log it, never store it in localStorage.
  - The Rust side passes it to the webview through a Tauri command.
  - Playwright passes it through `page.addInitScript`.
- **Artifact HTML:**
  - Rendered only in `<iframe sandbox="allow-scripts allow-popups">` from the files origin (`info.filesOrigin`).
  - Never `allow-same-origin`, never `srcdoc`, never fetched into the app's DOM.
- **Snapshot + seq rule (spec §5 S3):**
  - Open SSE first and buffer events.
  - Take the snapshot and read `X-Rooms-Seq`.
  - Drop buffered events with `seq <=` that scope's snapshot seq.
  - Apply the rest by id: upsert or delete, idempotently.
  - Every (re)connect starts with `resync {roomId: null}` and triggers a full refetch.
- **Thread red (`#ff385c` / `thread-deep`)** may be used in only one place: the single primary action on a screen. The new-doc dot is ink `#222`. The active nav icon fill is `thread-tint #fff0f3`. Focus rings are ink. Errors use `#c13515` with an icon.
- **Korean copy** must match this plan exactly. Error copy comes from spec §3.
- **Fonts and assets** are bundled locally; no CDN at runtime.
- **Plan 1 behavior:** the Rust workspace tests (`cargo test --workspace -- --test-threads=1`) must keep passing after Task 0.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.superpowers/`.

## Review Focus

1. **Reconnect mid-change.** An artifact is added while the SSE connection is down. After the reconnect, the card appears exactly once, and a card removed during the gap is gone. No duplicates, no ghosts.
2. **Rename while the room's tab is open.** A room is renamed (in the app or in Finder) while its tab is open. The tab title and sidebar update in place, and the tab keeps working (same room id).
3. **Note autosave on a flaky daemon.** Typing in a note while the daemon briefly returns 500. The text is never lost: retries go at 1s/2s/4s, then the user sees "저장하지 못했어요. 다시 시도할게요". The textbox keeps the edit.
4. **Hostile artifact HTML.** An artifact that runs `top.location = …`, `fetch('http://127.0.0.1:4317/v1/rooms', {method:'POST'})` or `parent.postMessage`. The app does not navigate, no write succeeds, and the app ignores the messages.
5. **Daemon already running, or the port is busy.** If a daemon is already serving, the app reuses it. If the port is held by something that is not roomsd, the app shows "Rooms 코어를 시작하지 못했어요" instead of hanging.

## File Structure

```
package.json                         # NEW bun workspace root: workspaces ["apps/*","packages/*"]
crates/roomsd/src/{lib.rs,guard.rs,routes.rs,main.rs}   # Task 0: NetConfig, note GET
crates/rooms-core/src/{core.rs,error.rs}                 # Task 0: read_note, CoreError::NotFound
packages/protocol-ts/src/{client.ts,index.ts}            # Task 0: getNote, index re-exports
apps/desktop/
  package.json  vite.config.ts  tsconfig.json  index.html  components.json
  playwright.config.ts
  src/
    main.tsx  App.tsx  styles.css (tokens + fonts)
    lib/connection.ts        # Task 2: resolve {baseUrl, token} (Tauri command or window.__ROOMS_DEV__)
    lib/native.ts            # Task 2: pickFolder, openInEditor, viewerInitial (Tauri or web fallbacks)
    data/roomsStore.ts       # Task 3
    data/viewerStore.ts      # Task 3
    data/hooks.ts            # Task 3 (useRooms, useArtifacts, useJournalDay, useViewer)
    data/*.test.ts           # Task 3 Vitest
    shell/AppShell.tsx  shell/Sidebar.tsx  shell/TabBar.tsx  shell/NewRoomRow.tsx   # Task 4
    views/RoomView.tsx  views/ArtifactCard.tsx  views/EmptyRoom.tsx  views/EditableTitle.tsx  # Task 5
    views/DocView.tsx  views/JournalView.tsx  views/NoteView.tsx  views/WeekStrip.tsx       # Task 6
    views/NewTabView.tsx  views/QuickFind.tsx                                               # Task 7
    assets/{otter-avatar.svg, clew-peek.svg, logo.svg}
  e2e/{fixtures.ts, *.spec.ts}       # Task 8
  src-tauri/                          # Task 1/2: own Cargo workspace (excluded from root)
    Cargo.toml  tauri.conf.json  capabilities/default.json  build.rs
    src/{main.rs, lib.rs, daemon.rs}
    binaries/                         # roomsd-<target-triple> copied by scripts/build-sidecar.sh
apps/desktop/scripts/build-sidecar.sh
docs/superpowers/specs/2026-10-05-alto-rooms-v1-manual-test.html   # Task 8
```

## Design values (from the final canvas; use exactly)

**Shell:**
- App background `surface #f7f7f7`; text `ink #222`.
- Font: `Jost, 'Apple SD Gothic Neo', system-ui`. Mono is IBM Plex Mono and is used only for dates and paths.
- Layout: sidebar (max 232px, padding 16px 10px) next to a content column (padding 8px 8px 8px 0).
- Content column: tab bar on top, then one main panel (1px `#ddd` border, radius 14).

**Tab bar:**
- Gap 4, padding `0 4px 8px`.
- Tab: min-height 34, padding `0 12px`, radius 8, 14px text, max-width 220 with ellipsis, gap 8, leading 15px lucide icon (`Folder` for a room, `FileText` for a doc or note, `Calendar` for Journal, `LayoutGrid` for a new tab).
- Active tab: 1px `#ddd` border, white background, `#222`. Inactive tab: transparent border, `#6a6a6a`.
- Close: a 16px `X` appears on hover at the tab's right edge (aria-label "탭 닫기"). ⌘W closes the active tab; middle-click closes too.
- Trailing `+` button: 32×32, aria-label "새 탭".
- Tab labels:
  - room: room name
  - doc: artifact title
  - Journal: `Journal · {M}월 {D}일`
  - note: note name without `.md`
  - new tab: `새 탭`

**Sidebar:** shadcn `Sidebar collapsible="offcanvas"`.
- Header: logo 26×26 + "Rooms" (17px/500), and a collapse button on the right (32×32, `PanelLeft`, aria-label "사이드바 접기 (⌘B)").
- Items (min-height 36, padding `0 10px`, radius 8, 15px, gap 10, icon 17px stroke 1.75):
  - "찾기" (`Search`, `#6a6a6a`)
  - "Journal" (`Calendar`, `#222`)
- Section label "방" (12px `#929292`), with a `+` button (28×28, aria-label "새 방").
- Room rows: `Folder` icon + name.
  - Active row: background `#ebebeb`, folder icon filled `#fff0f3`.
  - Hover: `#f2f2f2`.
  - Unavailable room: name at 50% opacity, with tooltip "폴더를 찾을 수 없어요".
- Order: as returned by `listRooms`.
- Double-click a row to edit its name inline (same component as the room title edit).
- No context menu, no delete.

**Collapsed sidebar:**
- The sidebar is hidden entirely.
- The tab bar gets a leading 32×32 button (`PanelLeft`, aria-label "사이드바 펼치기 (⌘B)").
- ⌘B toggles. The state persists.

**New room row:**
- Appears at the top of the room list: white background, radius 8, `box-shadow: 0 0 0 2px #222`, folder icon, input with visually hidden label "새 방 이름", trailing hint "↵" (12px `#929292`).
- Enter creates the room and opens its tab. Escape cancels.
- Below the row: a quiet text button "기존 폴더 연결…". It opens the native folder picker and calls `linkFolder`.

**Room view:**
- Panel: background `#f7f7f7`, padding `40px 48px 24px`, gap 24.
- h1: room name, 30px/500, letter-spacing -0.01em. Subtitle: `문서 {artifactCount}` (16px `#6a6a6a`).
- Strip:
  - horizontal scroll, gap 28, bleeds to the panel edges (`margin 0 -48px; padding 0 48px`)
  - oldest on the left, newest on the right
  - auto-scrolled to the right end on first open
- Card:
  - Width 300. The hovered card widens to 440 and its page grows from 420 to 560 tall, with shadow `0 6px 16px rgba(0,0,0,.12)`. Other cards: page 420 tall, opacity .85.
  - Page: white background, radius 12, 1px `#ddd`. It holds a scaled iframe preview.
  - Below the page: title (15px/500, ellipsis), an optional new-doc dot (6px circle, `#222`), and a right-aligned date in mono 12px `#929292`. The date reads `오늘` when created today, otherwise `MM·DD`.
- Expand button (shown on hover):
  - position: top 12, right 12; size 36×36, radius 8
  - style: 1px `#ddd` border, white background, float shadow, `Maximize2` icon
  - aria-label "새 탭에서 크게 보기"
  - click opens a doc tab
- Title edit:
  - Click the h1 to turn it into an input: same type, white background, 2px `#222` outline, radius 8, padding `2px 8px`, margin-left -8, max-width 560, aria-label "방 이름".
  - A hint below reads "Enter 또는 바깥을 누르면 저장" (14px `#929292`).
  - Enter or blur saves. Escape cancels.
  - On error, stay in edit mode and show the spec §3 copy below the input in `#c13515` with a `CircleAlert` icon.

**Empty room:**
- Centered Clew peek illustration, 220px wide, alt "물 위로 막 올라온 수달 Clew".
- "아직 아티팩트가 없어요" (17px `#222`).
- "에이전트에게 이 폴더에 HTML로 저장해 달라고 하세요" (15px `#6a6a6a`).
- A mono chip showing the folder path with `~` for the home directory (13px `#6a6a6a`, white background, 1px `#ddd`, radius 8, padding `8px 12px`). Clicking it copies the absolute path and shows "복사했어요" for 1.5s.

**Doc tab:**
- White panel with no padding. A full-size sandboxed iframe of `fileUrl(info, artifact)`.
- If the artifact is removed, show "이 문서는 더 이상 없어요" centered.

**Journal:**
- White panel, padding `36px 48px 24px`, gap 26.
- Header:
  - h1 `{M}월 {D}일 {요일}요일` (30px/500), plus "오늘" (17px `#6a6a6a`) when the date is today.
  - On the right, a week strip:
    - `‹` (aria "이전 주")
    - 7 day buttons: 44 wide, min-height 44, radius 8, weekday letters `일 월 화 수 목 금 토` (12px) over the date number (15px). Selected day: `#222` background, white text. Others: `#6a6a6a`.
    - `›` (aria "다음 주")
- Row "에이전트가 쓴 것":
  - Label: a 24px otter avatar in a `#f2f2f2` circle, "에이전트" (15px/500) and the count (`#929292`).
  - Cards: 220 wide, page 250 tall.
  - Each card's label slot shows the source room name, except the Dream card, which shows "복습".
  - Dream card (`relPath` ends with `/dream.html`) comes first. The rest are ordered by createdAt.
  - Hover shows the expand button: 34×34, at top 10 / right 10.
- Row "내가 쓴 것":
  - Label: a 24px circle (`#222` background, white 12px text) with the viewer's initial, then "나" and the count.
  - First card: a dashed "새 노트" card, 160×150, 1px dashed `#ddd`, `+` (22px) over "새 노트" (15px `#6a6a6a`).
  - Note cards: 220×150, titled with the note name without `.md`, date `오늘` or `MM·DD`.

**New note:**
- Clicking "새 노트" turns the card into an inline input (label "노트 이름"). The default value is "계획" if no 계획 note exists, else "회고" if no 회고 note exists, else empty.
- Enter calls `saveNote(date, name, "")` and opens the note tab.

**Note tab:**
- White panel, padding `40px 48px`.
- Header: h1 with the note name; a right-aligned quiet button "다른 편집기로 열기" (`ExternalLink` icon).
- Body: one `<textarea>` filling the rest of the panel (16px/1.7 Jost, no border, no toolbar), aria-label "노트".
- Autosave:
  - Save 800ms after typing stops, and on blur.
  - On failure, retry at 1s, 2s and 4s. After 3 failures show "저장하지 못했어요. 다시 시도할게요" and keep retrying every 10s. The text stays.
- External changes: on `note.saved` for this note while the textarea is not focused and has no unsaved edits, reload the body.

**New tab:**
- White panel, padding `56px 48px 40px`, gap 32.
- h1 "지난 방문 이후" (32px/500).
- Subtitle (17px `#6a6a6a`): `방 {n}곳에 새 문서가 들어왔어요.`, or "새로 들어온 문서가 없어요." when n is 0.
- Grid: `repeat(auto-fill, minmax(300px, 1fr))`, gap 12. Card: padding `18px 20px`, 1px `#ddd`, radius 14.
  - Name: 18px/500.
  - Line: `새 문서 {k}` (14px `#222`), omitted when k = 0. Then `문서 {artifactCount}` (14px `#6a6a6a`).
  - Clicking a card opens the room tab.
  - Rooms with new docs sort first, then by name.

**Quick find (⌘K, or the sidebar "찾기"):**
- shadcn `CommandDialog` with placeholder "방이나 문서 찾기".
- Groups "방" and "문서". A document item shows its title plus its room name in mono `#929292`.
- Enter opens the room tab or the doc tab.
- Matching: case-insensitive substring on NFC-normalized text.

**Errors (spec §3, verbatim):**

| Code | Message |
|---|---|
| `invalid_room_name` | "쓸 수 없는 이름이에요" |
| `room_exists` | "같은 이름의 방이 있어요" |
| linked unavailable | "폴더를 찾을 수 없어요" |
| daemon start failure | "Rooms 코어를 시작하지 못했어요" (a full-panel message with a "다시 시도" button) |
| `unsupported_version` | "앱을 업데이트해 주세요" |
| `write_failed` | "저장하지 못했어요. 다시 시도할게요" |
| any other error | "문제가 생겼어요" |

---

### Task 0: roomsd and client additions the app needs

**Files:**
- Modify:
  - `crates/rooms-core/src/{error.rs,core.rs}`
  - `crates/roomsd/src/{lib.rs,guard.rs,routes.rs,main.rs}`
  - `crates/roomsd/tests/api.rs` (`AppState` literals)
  - `packages/protocol-ts/src/client.ts`
- Create: `packages/protocol-ts/src/index.ts`, root `package.json`
- Test: `crates/roomsd/tests/api.rs`, `crates/rooms-core/tests/core_flows.rs`

**Interfaces:**
- Produces (Rust):
  - `CoreError::NotFound` → code `"not_found"`, status 404 (additive).
  - `RoomsCore::read_note(&self, date: &IsoDate, name: &str) -> Result<String, CoreError>`. It validates the date and note name the same way `save_note` does, and reads `journal/<date>/<name>.md`. A missing file returns `NotFound`. It takes no global lock while reading; the notes lock is enough.
  - `GET /v1/journal/{date}/notes/{name}` → 200 `text/markdown; charset=utf-8` with the body. Errors use the usual `ApiError` JSON.
  - `pub struct NetConfig { pub api_port: u16, pub files_port: u16, pub dev_origin: Option<String> }` with `Default` = 4317/4318/None, and `NetConfig::from_env()`, which reads `ROOMS_API_PORT`, `ROOMS_FILES_PORT` and `ROOMS_DEV_ORIGIN`.
  - `AppState` gains `pub net: NetConfig`.
  - The host allow-lists become `127.0.0.1:{port}` and `localhost:{port}` for the configured ports.
  - The Origin allow-list (write guard and CORS) is the existing three origins plus `net.dev_origin` when it is set.
  - `files_origin` in `main.rs` = `http://127.0.0.1:{files_port}`.
- Produces (TS):
  - `getNote(date: string, name: string): Promise<string>`
  - `packages/protocol-ts/src/index.ts` re-exports everything from `client.ts` and every generated type.
  - The package `"main"` points to `src/index.ts`.
- Root `package.json`: `{"private": true, "workspaces": ["apps/*", "packages/*"]}`

- [ ] **Step 1: Write the failing tests**

Append to `crates/roomsd/tests/api.rs`. Adapt `app()` so it builds `AppState { …, net: NetConfig::default() }`:
```rust
#[tokio::test]
async fn note_get_returns_markdown_and_404_for_missing() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let put = Request::put("/v1/journal/2026-10-05/notes/%EA%B3%84%ED%9A%8D")
        .header("host", "127.0.0.1:4317").header("authorization", "Bearer t0k")
        .header("content-type", "text/markdown").body(Body::from("- 할 일")).unwrap();
    assert_eq!(app.clone().oneshot(put).await.unwrap().status(), StatusCode::OK);
    let r = app.clone().oneshot(Request::get("/v1/journal/2026-10-05/notes/%EA%B3%84%ED%9A%8D").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.headers()["content-type"].to_str().unwrap().starts_with("text/markdown"));
    assert_eq!(&r.into_body().collect().await.unwrap().to_bytes()[..], "- 할 일".as_bytes());
    let r = app.oneshot(Request::get("/v1/journal/2026-10-05/notes/none").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(r).await["error"], "not_found");
}

#[tokio::test]
async fn custom_ports_and_dev_origin() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let net = NetConfig { api_port: 14317, files_port: 14318, dev_origin: Some("http://localhost:4173".into()) };
    let st = AppState { core, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
    let app = build_api_router(st).layer(MockConnectInfo("127.0.0.1:5000".parse::<SocketAddr>().unwrap()));
    let mut ok = post("/v1/rooms", r#"{"name":"a"}"#, Some("t0k"), "127.0.0.1:14317");
    ok.headers_mut().insert("origin", "http://localhost:4173".parse().unwrap());
    assert_eq!(app.clone().oneshot(ok).await.unwrap().status(), StatusCode::OK);
    let old_port = Request::get("/v1/rooms").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(old_port).await.unwrap().status(), StatusCode::FORBIDDEN);
    let mut evil = post("/v1/rooms", r#"{"name":"b"}"#, Some("t0k"), "127.0.0.1:14317");
    evil.headers_mut().insert("origin", "http://localhost:9999".parse().unwrap());
    assert_eq!(app.oneshot(evil).await.unwrap().status(), StatusCode::FORBIDDEN);
}
```
Append to `core_flows.rs`:
```rust
#[test]
fn read_note_roundtrip_and_not_found() {
    let (_d, core) = home();
    core.save_note(&"2026-10-05".to_string(), "회고", "오늘 배운 것").unwrap();
    assert_eq!(core.read_note(&"2026-10-05".to_string(), "회고").unwrap(), "오늘 배운 것");
    assert_eq!(core.read_note(&"2026-10-05".to_string(), "없음").unwrap_err(), CoreError::NotFound);
    assert!(core.read_note(&"2026-10-05".to_string(), "../x").is_err());
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `. ~/.cargo/env && cargo test --workspace -- --test-threads=1`
Expected: compile errors (no `NetConfig`, no `read_note`, no `NotFound`).

- [ ] **Step 3: Implement**

The guards take their lists from `AppState.net`:
```rust
fn hosts(port: u16) -> [String; 2] { [format!("127.0.0.1:{port}"), format!("localhost:{port}")] }
fn origin_allowed(st: &AppState, o: &str) -> bool { ALLOWED_ORIGINS.contains(&o) || st.net.dev_origin.as_deref() == Some(o) }
```
The CORS layer uses `AllowOrigin::predicate` with the same rule. `main.rs` builds `NetConfig::from_env()`, binds `127.0.0.1:{api_port}` and `127.0.0.1:{files_port}`, and prints them. Adding `"not_found"` to the error-code list in spec §3 is deferred to the docs task. In `client.ts`:
```ts
getNote: async (date: string, name: string): Promise<string> => {
  const r = await fetch(`${baseUrl}/v1/journal/${date}/notes/${encodeURIComponent(name)}`);
  if (!r.ok) throw await failure(r);
  return r.text();
},
```

- [ ] **Step 4: Verify**

Run: `cargo test --workspace -- --test-threads=1 && bunx -p typescript tsc --noEmit -p packages/protocol-ts`
Expected: all green, no warnings.

- [ ] **Step 5: Commit**

`git add crates packages package.json Cargo.lock && git commit -m "feat(roomsd): note read endpoint, configurable ports and dev origin; client getNote"`

---

### Task 1: Scaffold `apps/desktop` (Vite + React + Tailwind v4 + shadcn + Tauri)

**Files:** everything under `apps/desktop/` listed in File Structure, except the views. Add `apps/desktop/src-tauri` to the root `Cargo.toml` `[workspace] exclude`.

**Interfaces:**
- **Scripts in `apps/desktop/package.json`:**
  - `dev` (vite on 1420)
  - `build` (`tsc -b && vite build`)
  - `preview` (vite preview on 4173)
  - `test` (vitest run)
  - `e2e` (playwright test)
  - `tauri` (`tauri`)
  - `sidecar` (`bash scripts/build-sidecar.sh`)
- **`styles.css`:**
  - `@import "tailwindcss";`
  - the Alto tokens: copy `~/personal/alto-site/design/tokens.css` verbatim (its `:root`, `.dark` and `@theme inline` blocks). Its dark canvas value `#121212` wins over the DS page.
  - `@fontsource/jost` 400/500/600 and `@fontsource/ibm-plex-mono` 400 imports
  - `body { font-family: Jost, 'Apple SD Gothic Neo', system-ui; background: var(--surface); color: var(--ink); }`
- **shadcn components:** `sidebar`, `command`, `dialog`, `button`, `input`, `tooltip`. Install them non-interactively (`bunx shadcn@latest add … -y`) and keep them under `src/components/ui`.
- **Assets.** Copy from `~/Downloads/alto-brand`:
  - `alto-otter-avatar.svg` → `src/assets/otter-avatar.svg`
  - `poses/clew-5-peek.svg` → `src/assets/clew-peek.svg`
  - `alto-otter-full.svg` → `src/assets/logo.svg`
  - App icons: `bunx tauri icon ~/Downloads/alto-brand/favicon-512.png`
- **`src-tauri/tauri.conf.json`:**
  - `productName` "Alto Rooms", identifier `computer.alto.rooms`
  - `build.devUrl` `http://localhost:1420`, `frontendDist` `../dist`
  - `bundle.externalBin: ["binaries/roomsd"]`
  - CSP: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:4317; frame-src http://127.0.0.1:4318; img-src 'self' data: http://127.0.0.1:4318; style-src 'self' 'unsafe-inline'; font-src 'self'`
- **`capabilities/default.json`:** `core:default`, `shell:allow-spawn` (sidecar `binaries/roomsd` only), `dialog:allow-open`, `opener:allow-open-path` scoped to `$HOME/rooms/**`.
- **`scripts/build-sidecar.sh`:** `cargo build -p roomsd --release` from the repo root, then copy `target/release/roomsd` to `src-tauri/binaries/roomsd-$(rustc -vV | sed -n 's/host: //p')`.
- **`App.tsx`:** for now, renders a placeholder that says "Rooms".

- [ ] **Step 1: Write the failing test.** `src/smoke.test.tsx`: render `<App/>` with Testing Library and expect the text "Rooms".
- [ ] **Step 2: Run it.** `bun install && bun run --cwd apps/desktop test` should fail because there is no App yet.
- [ ] **Step 3: Implement the scaffold** as specified above.
- [ ] **Step 4: Verify.** Each of these must pass:
  - `bun run --cwd apps/desktop test`
  - `bun run --cwd apps/desktop build`
  - `bun run --cwd apps/desktop sidecar`
  - `cd apps/desktop/src-tauri && cargo check`
  - `cargo test --workspace -- --test-threads=1` from the repo root (it must still exclude src-tauri)
- [ ] **Step 5: Commit.** `feat(desktop): scaffold Tauri + React + Tailwind v4 + shadcn with Alto tokens`

---

### Task 2: Daemon launch and native bridges

**Files:**
- `apps/desktop/src-tauri/src/{lib.rs,daemon.rs}`
- `apps/desktop/src/lib/{connection.ts,native.ts}`
- Tests: `src-tauri/src/daemon.rs` unit tests, `src/lib/connection.test.ts`

**Interfaces:**
- **Rust command `connect() -> Result<Connection, String>`**, where `Connection { base_url: String, token: String, home: String }` (serde camelCase). Steps:
  1. **Probe.** `GET http://127.0.0.1:4317/v1/info` with a 500 ms timeout. Use `reqwest` (blocking, rustls) or `ureq`; pick one and keep the dependency small.
  2. **If the probe returns 200 with `version == "1"`,** reuse that daemon: `home = info.home`.
  3. **Otherwise spawn the sidecar** `roomsd` via `tauri_plugin_shell`.
     - In debug builds, set env `ROOMS_DEV_ORIGIN=http://localhost:1420`.
     - Store the `CommandChild` in managed state.
     - Poll `/v1/info` every 100 ms for up to 5 s.
     - If the child exits with code 2, or the poll times out, return `Err("Rooms 코어를 시작하지 못했어요")`.
  4. **Read the token** from `{home}/.rooms/token`, trimmed.
- **`viewer_initial() -> String`:** the first char of `$USER`, uppercased, or "나" if it is unavailable.
- **On `RunEvent::Exit`:** kill the child only if this app spawned it.
- **`connection.ts`:** `export async function resolveConnection(): Promise<{ baseUrl: string; token: string; home: string }>`
  - Inside Tauri (`'__TAURI_INTERNALS__' in window`): `invoke('connect')`.
  - Otherwise: `window.__ROOMS_DEV__`. If it is missing, throw.
- **`native.ts`:**
  - `pickFolder(): Promise<string | null>` (dialog in Tauri; `window.prompt` in web)
  - `openInEditor(absPath: string): Promise<void>` (opener `openPath` in Tauri; no-op in web)
  - `viewerInitial(): Promise<string>` (command in Tauri; `"J"` in web)
- **`App.tsx`:**
  - On mount, call `resolveConnection`.
  - While it is pending, show an empty panel.
  - On error, show the full-panel "Rooms 코어를 시작하지 못했어요" with a "다시 시도" button that re-runs it.

- [ ] **Step 1: Write failing tests.**
  - Rust: `daemon.rs` has a pure fn `parse_info(body: &str) -> Option<String /*home*/>` that accepts only `version == "1"`. Unit-test it with good JSON, a wrong version, and garbage.
  - TS: `connection.test.ts`. With no Tauri and no `__ROOMS_DEV__`, it rejects. With `__ROOMS_DEV__`, it returns it.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
  - `cargo test` in src-tauri
  - `bun run --cwd apps/desktop test`
  - Manual: `bun run --cwd apps/desktop sidecar && bun run --cwd apps/desktop tauri dev` with `ROOMS_HOME` pointing at a `mktemp -d` home. The app window opens with no error panel, and `lsof -i :4317` shows roomsd. Quit the app; roomsd is gone. Record this in the report.
- [ ] **Step 5: Commit.** `feat(desktop): sidecar roomsd launch/reuse, token handoff, native bridges`

---

### Task 3: Data layer: RoomsStore (seq rule), ViewerStore, hooks

**Files:** `apps/desktop/src/data/{roomsStore.ts,viewerStore.ts,hooks.ts,roomsStore.test.ts,viewerStore.test.ts}`

**Interfaces (frozen):**
```ts
import type { Artifact, Info, JournalDay, Room, RoomsEvent, Snapshot } from "@alto-rooms/protocol-ts";

export type RoomsClientLike = {
  info(): Promise<Info>;
  listRooms(): Promise<Snapshot<Room[]>>;
  listArtifacts(roomId: string): Promise<Snapshot<Artifact[]>>;
  journalDay(date: string): Promise<Snapshot<JournalDay>>;
  subscribe(onEvent: (e: RoomsEvent) => void, onOpen?: () => void): () => void;
};

export type RoomsState = {
  status: "connecting" | "live" | "error";
  info: Info | null;
  rooms: Room[];                                   // listRooms order
  artifacts: Record<string, Artifact[] | undefined>; // roomId -> createdAt ASC; undefined = not loaded
  days: Record<string, JournalDay | undefined>;    // date -> day; undefined = not loaded
};

export class RoomsStore {
  constructor(client: RoomsClientLike);
  start(): void;                       // subscribe first (buffering), then full sync
  stop(): void;
  getState(): RoomsState;              // immutable snapshots (new object on every change)
  subscribe(listener: () => void): () => void;
  loadArtifacts(roomId: string): Promise<void>;   // marks the room "watched": refetched on resync
  loadDay(date: string): Promise<void>;           // marks the day "watched"
}
```
**Rules:**

*Buffering and sync*
- From `start()`, and again after every `onOpen`, the store is in **buffering** mode.
- While buffering, events go into a queue.
- A resync fetches:
  - `listRooms()`
  - `listArtifacts()` for every watched room
  - `journalDay()` for every watched day

  Each scope records its snapshot `seq`.
- After a resync, apply the queued events in order, using the per-scope rule:
  - **Rooms scope:** `room.*` events. Drop the event if `e.seq <= roomsSeq`.
  - **Artifact scope** (one per room): `artifact.*` events. Drop if `e.seq <= artifactsSeq[roomId]`. Ignore the event if the room is not watched.
  - **Days:** refetch on `journal.changed {date}` if the day is watched; debounce 150 ms per date. `note.saved` / `note.removed` also refetch that date if watched.
- After the queue drains, leave buffering mode. Live events then apply directly, under the same per-scope rule.

*Events*
- `resync {roomId: null}`: start buffering again and run a full resync.
- `resync {roomId}`: refetch that room's artifacts only.
- `room.removed`: drop the room from the room list and delete `artifacts[roomId]`.

*Apply semantics*
- Applying is by id and idempotent:
  - `artifact.added` and `artifact.updated` both upsert, then re-sort by createdAt then id.
  - `removed` deletes.
- `status` becomes `"live"` after the first successful sync, and `"error"` if `info()` fails. While in error, retry the sync with backoff: 1 s, 2 s, 4 s, max 10 s.
```ts
export type Tab =
  | { id: string; kind: "room"; roomId: string }
  | { id: string; kind: "doc"; roomId: string; artifactId: string }
  | { id: string; kind: "journal"; date: string }
  | { id: string; kind: "note"; date: string; name: string }
  | { id: string; kind: "new" };

export type ViewerState = {
  tabs: Tab[]; activeId: string | null; sidebarOpen: boolean;
  lastVisit: Record<string, string>;   // roomId -> ISO time the user last LEFT that room tab
  firstRunAt: string;                  // rooms never visited use this as their last visit
};

export class ViewerStore {
  constructor(storage?: Pick<Storage, "getItem" | "setItem">, now?: () => Date);
  getState(): ViewerState; subscribe(l: () => void): () => void;
  open(tab: Omit<Tab, "id">, opts?: { activate?: boolean }): string; // re-activates an existing equal tab instead of duplicating
  close(id: string): void;             // activates the right neighbour, else left, else null
  activate(id: string): void;          // leaving a room tab records lastVisit[roomId] = now
  setSidebarOpen(open: boolean): void;
  isNew(a: Artifact): boolean;          // a.createdAt > (lastVisit[a.roomId] ?? firstRunAt)
}
```
**Viewer state rules:**
- Persist to localStorage under the key `alto-rooms.viewer.v1`. Never store anything from the server other than ids.
- Two tabs are equal when their kind and every id field match.
- When the app starts with no saved tabs, open a `new` tab.

**Hooks** (`useSyncExternalStore`):
- `useRooms()`
- `useArtifacts(roomId)` (calls `loadArtifacts` on mount)
- `useJournalDay(date)`
- `useViewer()`
- `useRoomsStore()` / `useViewerStore()` via React context. `App` creates the stores after `resolveConnection`.

- [ ] **Step 1: Write failing Vitest tests.** Use a `FakeClient` whose snapshot results and event stream are scripted. Cover:
  - **Reconnect gap (Review Focus #1):**
    - Start: snapshot seq 5 with artifacts a1 and a2.
    - Disconnect. While disconnected, the server adds a3 (seq 6) and removes a1 (seq 7).
    - On reconnect, `onOpen` fires, then events `resync {null}` at seq 7 and a stale `artifact.added a1` at seq 4.
    - The new snapshot at seq 7 holds a2 and a3.
    - Expect exactly `[a2, a3]`.
  - **Buffered event dropping:**
    - An event with seq ≤ the snapshot seq that arrives during sync is dropped.
    - An event with seq > the snapshot seq is applied.
  - **Room rename:** `room.updated` keeps the room's array position and its artifacts.
  - **`room.removed`:** removes the room and its artifacts.
  - **`journal.changed`:** refetches only watched days, and is debounced: 3 events produce 1 fetch.
  - **ViewerStore:**
    - `open` de-duplicates tabs.
    - Closing a tab activates its neighbour.
    - `lastVisit` is recorded when the user leaves a room tab.
    - `isNew` uses `firstRunAt` for rooms never visited.
    - State persists across instances.
- [ ] **Step 2: Run the tests.** `bun run --cwd apps/desktop test` fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** All tests pass.
- [ ] **Step 5: Commit.** `feat(desktop): RoomsStore with snapshot+seq rule, ViewerStore, hooks`

---

### Task 4: Shell (sidebar, tab bar, room create/rename, ⌘B/⌘W)

**Files:**
- `src/shell/{AppShell.tsx,Sidebar.tsx,TabBar.tsx,NewRoomRow.tsx}`
- `src/views/EditableTitle.tsx` (shared inline editor)
- Tests: `src/shell/*.test.tsx` (Testing Library, with the stores built on `FakeClient` from Task 3)

**Interfaces:**
- `EditableTitle({ value, onSave(next): Promise<void>, onCancel?, className, ariaLabel, hint })`:
  - Click enters edit mode. Enter or blur saves. Escape cancels.
  - While saving, the input is disabled.
  - If `onSave` rejects with a `RoomsApiError`, stay in edit mode and show the mapped spec §3 copy.
  - Used by the room h1 (hint "Enter 또는 바깥을 누르면 저장") and by the sidebar row on double-click (no hint).
- `errorCopy(e: unknown): string` lives in `src/lib/errors.ts` and maps codes to the table in §Design values.
- The sidebar and tab bar follow §Design values exactly.
- Keyboard:
  - ⌘B toggles the sidebar (`ViewerStore.setSidebarOpen`).
  - ⌘W closes the active tab.
  - ⌘T opens a new tab.
  - ⌘K opens Quick find. Before Task 7 this is a stub.
- Room tab titles and sidebar names come from `RoomsState.rooms` by id. They are never cached in the tab.
- A tab whose room disappears (`room.removed`) shows "이 방은 더 이상 없어요" in its panel. The tab stays until the user closes it.
- When `info.readOnly`, every write affordance is hidden: `+`, edit on click, "기존 폴더 연결…", "새 노트", and the textarea becomes readOnly.

- [ ] **Step 1: Write failing tests.**
  - Clicking `+` shows the input. Typing "연구 도구" and pressing Enter calls `createRoom("연구 도구")` and opens and activates a room tab.
  - When `createRoom` rejects with `room_exists`, "같은 이름의 방이 있어요" is visible and the input stays.
  - ⌘B hides the sidebar, and the tab bar shows "사이드바 펼치기 (⌘B)". ⌘B again shows the sidebar.
  - Double-clicking a sidebar row edits the name, and Enter calls `renameRoom`.
  - Hovering a tab and clicking "탭 닫기" closes it. ⌘W closes the active tab.
  - With `readOnly`, no "새 방" button is present.
- [ ] **Step 2: Run the tests** and confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and confirm they pass.
- [ ] **Step 5: Commit** with message `feat(desktop): shell — sidebar, tabs, room create/rename, shortcuts`.

---

### Task 5: Room view (strip, cards, previews, expand, empty state)

**Files:**
- Create: `src/views/{RoomView.tsx,ArtifactCard.tsx,EmptyRoom.tsx}`
- Test: `src/views/RoomView.test.tsx`

**Interfaces:**
- **`ArtifactCard({ artifact, info, label, isNew, size: "strip" | "journal", onExpand })`**
  - Renders the page with a scaled `<iframe sandbox="allow-scripts allow-popups" src={fileUrl(info, artifact)} loading="lazy" tabIndex={-1} style={{ pointerEvents: "none" }}>`.
  - The iframe is laid out at 1280×(1280·pageH/pageW) and `transform: scale(pageW/1280)`.
  - Mount the iframe only while the card is within 1 viewport of the strip (IntersectionObserver with `rootMargin` "100%"). Otherwise render the blank page box.
  - `label` is the date text (`오늘` or `MM·DD`, computed from `createdAt` in local time) or a room name.
  - Clicking the card body also opens the doc tab, the same as the expand button.
- **`RoomView({ roomId })`**
  - Header uses `EditableTitle`, plus a subtitle.
  - Strip of `ArtifactCard`s.
  - When the room has 0 artifacts, render `EmptyRoom`.
  - On the first render that has artifacts, scroll the strip to its right end.
  - When `artifact.added` arrives while the strip is already scrolled to the right end, keep it pinned there.
  - New-doc dot: `viewer.isNew(a)` evaluated **at the moment the tab was activated**. Capture `lastVisit` when the tab becomes active, so dots don't vanish while the user is looking at them.
- **`EmptyRoom({ room, home })`**
  - Shows the path chip. Display `~/…` when `room.path` starts with `home`'s parent home directory; otherwise show the absolute path.
  - Clicking the chip runs `navigator.clipboard.writeText(room.path)` and shows "복사했어요" for 1.5 s.

- [ ] **Step 1: Write failing tests.**
  - The strip renders cards oldest→newest.
  - A card created today shows "오늘".
  - The expand button has aria-label "새 탭에서 크게 보기", and clicking it opens a doc tab.
  - A new artifact (`createdAt` > `lastVisit`) shows the dot.
  - An empty room shows "아직 아티팩트가 없어요" and the path chip.
  - The iframe has `sandbox` and does not contain `allow-same-origin`.
- [ ] **Step 2: Run the tests** and confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and confirm they pass.
- [ ] **Step 5: Commit** with `feat(desktop): room strip with sandboxed live previews and empty state`.

---

### Task 6: Doc tab, Journal, and Note tab

**Files:**
- Create: `src/views/{DocView.tsx,JournalView.tsx,WeekStrip.tsx,NoteView.tsx}`
- Test: `src/views/{JournalView,NoteView}.test.tsx`

**Interfaces:**

- **DocView({ roomId, artifactId })**
  - Renders a full-size sandboxed iframe of the artifact.
  - Loads the room's artifacts so the view can tell when the artifact has been removed.
  - Shows "이 문서는 더 이상 없어요" when the artifact is gone.

- **JournalView({ date })**
  - Contains a WeekStrip. Changing the date updates the same tab's `date`; it does not open a new tab.
  - **Agent row**
    - Dream card first: relPath = `{date}/dream.html`, label "복습".
    - Then the other artifacts, labelled with their source room name (from rooms by id; the journal room's own non-dream files are labelled "Journal").
  - **Me row**
    - Starts with a "새 노트" card. The name input uses the defaults described in §Design values.
    - Then the notes in name order.
  - **Sidebar "Journal" item:** opens or activates the journal tab for today (local date). Only one journal tab exists.

- **NoteView({ date, name })**
  - **Loading:** body comes from `client.getNote(date, name)`; show an empty textarea until it loads.
  - **Autosave**
    - Debounce 800 ms, and also save on blur.
    - On failure, retry after 1 s, 2 s and 4 s.
    - After the 3rd failure, show "저장하지 못했어요. 다시 시도할게요" and keep retrying every 10 s.
    - Never discard local text.
  - **Concurrent saves:** at most one save request is in flight. Edits made while a save is in flight trigger exactly one follow-up save.
  - **Reload on external change:** when `note.saved` arrives for this note, reload the body only if there are no unsaved edits and the textarea is not focused.
  - **"다른 편집기로 열기":** calls `openInEditor(`${info.home}/journal/${date}/${name}.md`)`.

- [ ] **Step 1: Write failing tests**
  - Journal orders Dream first and labels it "복습".
  - Another room's artifact shows that room's name.
  - The "새 노트" default is "계획", then "회고".
  - Use fake timers for the note tests:
    - Typing, then 800 ms idle, saves exactly once.
    - With `saveNote` failing 3 times, the error copy appears and the textarea still holds the text.
    - It recovers on the 4th attempt and the error copy disappears.
    - An edit during an in-flight save produces exactly one extra save.
- [ ] **Step 2: Run the tests** — they fail.
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests** — they pass.
- [ ] **Step 5: Commit** with message `feat(desktop): doc tab, Journal day view, note editor with autosave`.

---

### Task 7: New tab ("지난 방문 이후"), Quick find (⌘K), linking an existing folder

**Files:**
- Create: `src/views/{NewTabView.tsx,QuickFind.tsx}`
- Modify: `src/shell/NewRoomRow.tsx` (link button)
- Test: `src/views/{NewTabView,QuickFind}.test.tsx`

**Interfaces:**

- **NewTabView**
  - Loads the artifacts of every room. These loads are lazy and cached by the store.
  - Computes `newCount(room) = artifacts.filter(viewer.isNew).length`.
  - Uses the copy and ordering from §Design values.

- **QuickFind**
  - A `CommandDialog`, opened by ⌘K or the sidebar "찾기".
  - The first time it opens, it loads every room's artifacts.
  - Results group into "방" and "문서".
  - Matching is NFC + lowercase substring.
  - Opening a result opens the matching tab.

- **NewRoomRow link**
  - Shows a quiet "기존 폴더 연결…" button. Clicking it calls `pickFolder()`, then `client.linkFolder(path)`, then opens the room tab.
  - Errors show their copy under the row:
    - `invalid_link_path` → "폴더를 찾을 수 없어요"
    - `overlapping_room` → "이미 연결된 폴더와 겹쳐요"
    - add both to `errors.ts`

- [ ] **Step 1: Write failing tests**
  - With 2 rooms holding new docs, the subtitle reads "방 2곳에 새 문서가 들어왔어요.", and those rooms sort first with "새 문서 1".
  - With none new, the subtitle reads "새로 들어온 문서가 없어요."
  - QuickFind: typing "벤치" shows the "벤치마크 현황" doc under "문서", and Enter opens its doc tab.
  - Folder linking: with a mocked `pickFolder`, clicking the button links the folder and opens it.
- [ ] **Step 2: Run the tests** — they fail.
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests** — they pass.
- [ ] **Step 5: Commit** with message `feat(desktop): new tab since last visit, quick find, link existing folder`.

---

### Task 8: End-to-end tests against a real roomsd, app bundle smoke test, and the manual test guide

**Files:**
- Create: `apps/desktop/playwright.config.ts`, `apps/desktop/e2e/{fixtures.ts,rooms.spec.ts,journal.spec.ts,security.spec.ts}`
- Create: `docs/superpowers/specs/2026-10-05-alto-rooms-v1-manual-test.html`
- Modify: `docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-followups.md` (add `not_found` to the error list item)

**Interfaces:**

- **Fixture (`fixtures.ts`)**
  - Builds `roomsd` once with `cargo build -p roomsd`.
  - Per test, starts it with:
    - `ROOMS_HOME=<tmp>`
    - `ROOMS_API_PORT=14317`
    - `ROOMS_FILES_PORT=14318`
    - `ROOMS_DEV_ORIGIN=http://localhost:4173`
  - Waits for `/v1/info`, then reads the token.
  - Calls `page.addInitScript(({base, token, home}) => { window.__ROOMS_DEV__ = {baseUrl: base, token, home} }, …)`.
  - Kills the daemon after the test.
  - Playwright `webServer` runs `bun run build && bun run preview` on port 4173.
  - The web build's CSP comes from the Vite preview, not from Tauri. The iframe `src` is `http://127.0.0.1:14318`, taken from `info.filesOrigin`.

- **Specs**

  | Spec | Steps | Expected |
  |---|---|---|
  | `rooms.spec.ts` AC-5 | Click "새 방", type "연구 도구", press Enter | A tab "연구 도구" is open; `<home>/연구-도구` exists; the empty state is visible |
  | `rooms.spec.ts` AC-1 | `fs.writeFile(<home>/연구-도구/a.html, '<title>첫 문서</title>')` | Within 2 s a card titled "첫 문서" is visible, showing the dot |
  | `rooms.spec.ts` AC-6 | Click the h1, type "연구", press Enter | The folder `<home>/연구` exists; the tab label and sidebar read "연구" |
  | `rooms.spec.ts` AC-9 | Hover the card, click "새 탭에서 크게 보기" | A doc tab "첫 문서" is active, with an iframe pointing to `…:14318/…` |
  | `rooms.spec.ts` AC-14 | Press ⌘B | The sidebar is hidden and "사이드바 펼치기 (⌘B)" is visible; ⌘B restores it |
  | `rooms.spec.ts` Review Focus 2 | Rename the folder on disk with `fs.rename` while its tab is open | The tab label updates within 2 s and the tab still shows its cards |
  | `journal.spec.ts` AC-10 | Write `<home>/journal/<today>/dream.html` and a room artifact | The Journal shows Dream first, labelled "복습", and the room artifact labelled with its room name |
  | `journal.spec.ts` AC-11 | "새 노트", Enter (default "계획"), type "- 할 일", wait 1.5 s | `<home>/journal/<today>/계획.md` contains "- 할 일" |
  | `security.spec.ts` Review Focus 4 | An artifact with `<script>top.location='https://example.com'; fetch('http://127.0.0.1:14317/v1/rooms',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"x"}'})</script>` | The page URL is unchanged; after 1 s `listRooms` has no room "x" |

- **Bundle smoke test**
  - `bun run --cwd apps/desktop sidecar && bun run --cwd apps/desktop tauri build --bundles app`.
  - It must produce `Alto Rooms.app`.
  - Launch it with `open` against `ROOMS_HOME=$(mktemp -d)` via `launchctl setenv`, or skip the launch and report that it was skipped.
  - Record the result in the report.
  - Do not sign or notarize.

- **Manual test guide**
  - Write `manual-test.html` from the spec-driven-html template at `~/.claude/skills/spec-driven-html/templates/manual-test-template.html`, with three sections:
    - ✅ automated tests: commands and results
    - 🧪 golden path: install, first launch, create a room, have an agent write HTML, open it in a tab, write in the Journal
    - edge cases: Review Focus 1–5, each with action → expected → what to check if it differs

- [ ] **Step 1: Write the specs**
- [ ] **Step 2: Run them** with `bun run --cwd apps/desktop e2e`. Any failures are app bugs; fix them in the app, not in the tests.
- [ ] **Step 3: Run the bundle smoke test**
- [ ] **Step 4: Write `manual-test.html`** and update the follow-ups document
- [ ] **Step 5: Commit** with `test(desktop): e2e against real roomsd, bundle smoke, manual test guide`
