# Alto Rooms Plan 3: Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first launch, the user pastes one line into their own agent: `~/rooms/ONBOARD.md 를 읽고 따라 해줘`. The agent installs a `rooms` skill. It runs a deterministic script that finds the `.html` files the agent wrote in the last 14 days (from Claude Code and Codex session logs), proposes topic rooms, and asks the user to confirm once. It then creates the rooms as folders containing **symlinks to the originals**. Files it is unsure about go to `~/rooms/inbox/`. In the desktop app, the user can drag an inbox card onto a room to move it.

**Architecture:**
- **roomsd (Rooms core)** still runs no AI and knows nothing about agents.
  - Its only onboarding duty is to write three static files on `open`, embedded in the binary and refreshed by version marker:
    - `ONBOARD.md` in Home
    - the skill source under `.rooms/onboarding/skill/rooms/`
  - It also gains one generic write operation: `move_artifact`, which moves a link or file between owned rooms and keeps the first-seen `createdAt`.
- **The skill** does everything agent-side:
  - a Python 3 stdlib script `find_html.py` extracts candidate paths, deterministic and tested;
  - the agent does the judgement work: classify, confirm, then `mkdir` + `ln -s`.
- **The desktop app** shows the one-liner on the New tab when there are no rooms, lists inbox documents there as "방을 기다리는 문서", and makes inbox cards draggable onto sidebar rooms.

**Tech Stack:** Rust (rooms-core, roomsd), Python 3 stdlib (`find_html.py` + `unittest`), React (apps/desktop), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-05-alto-rooms-v1-spec.html`:
- US-8 and AC-15…18
- §2 rules: file links, link time, reserved names
- §5 S1, the folder contract
- §7 flow 5 (onboarding)

## Decisions (user, 2026-10-05)

1. **Where the one-liner shows.** When no rooms exist (inbox excluded), the New tab shows "이 한 줄을 에이전트에게 붙여넣으세요" with the prompt as a copy chip. A quiet sidebar link "에이전트로 정리하기", under the room list, opens or activates the New tab and keeps a compact re-run card visible.
2. **Inbox move.** This version includes it. Drag an inbox card (from the New tab section "방을 기다리는 문서" or from the inbox room strip) onto an owned room in the sidebar. The link moves; the original is never touched.
3. **The "habit"** ("앞으로 HTML 아티팩트를 만들면 알맞은 방에 링크하라"):
   - It lives in the skill.
   - At the end of onboarding, the agent **asks** whether to add one line to `~/.claude/CLAUDE.md` (Claude Code) or `~/.codex/AGENTS.md` (Codex).
   - It adds the line only on a yes.

## Decisions made while writing this plan (controller)

- **Who writes the onboarding files.** roomsd writes them on `RoomsCore::open`, because the spec says "앱은 첫 실행 때 둔다" and a headless roomsd user needs them too. They are plain static text with no AI.
  - Each file begins with a marker: `<!-- rooms-onboarding v1 -->` for Markdown, `# rooms-onboarding v1` for Python.
  - Write a file only when it is missing or its marker version is older. Never overwrite a file whose first line is not a marker; that means the user edited it.
- **Locations:**
  - `~/rooms/ONBOARD.md`
  - `~/rooms/.rooms/onboarding/skill/rooms/SKILL.md`
  - `~/rooms/.rooms/onboarding/skill/rooms/scripts/find_html.py`
- **What counts as "wrote a .html":**
  - Claude Code: `type=="assistant"` → `message.content[]` `tool_use` with name in {Write, Edit, MultiEdit, Artifact} and `input.file_path` ending `.html`/`.htm` (case-insensitive). `Read` is never counted.
  - Codex: `response_item` + `custom_tool_call` `exec` inputs.
    - apply_patch `*** (Add|Update) File: <path>`.
    - Shell writes via a loose regex. Relative paths resolve against the latest `session_meta`/`turn_context` cwd.
  - The 14-day window is measured by **log record timestamp**.
  - Keep only files that exist now. Dedupe by realpath.
- **Noise dropped by default:** `/tmp/`, `/private/tmp/`, `/var/folders/`, any `scratchpad` path segment, `node_modules`, `~/.claude/`, `~/.codex/`, `.superpowers/brainstorm`, `~/Documents/Codex/*/work/`, and anything already under `~/rooms`.
- **Worktree duplicates.** `find_html.py` reports a `repo_key`: the path with any `/<worktrees-root>/<repo>/<branch>/` prefix collapsed to `<repo>`, detected from a `.git` *file* in an ancestor, or from the `~/orca/workspaces/<repo>/<branch>/` pattern. The skill groups candidates by `repo_key` and relative path, and links the most recently written copy.
- **Link names.** Keep the original basename. On a collision inside the room, insert ` (2)`, ` (3)` and so on before `.html`. Room folder names follow the slug rule: NFC, spaces become `-`. The display name equals the folder name.
- **Journal day of a link** = the target's birthtime (existing behavior). This is accepted for v1. The spec's Q2 order settles it.

## Global Constraints

- Rooms core (`crates/`) contains no model calls, no prompts it executes, and no agent detection. The onboarding files are inert text that it only writes.
- **Originals are never modified, moved or deleted.** The skill only creates folders under `~/rooms` and symlinks. `move_artifact` only moves entries inside owned rooms.
- Linked rooms are never written to: `move_artifact` refuses a linked source or target with `invalid_input`. Journal is never a move target.
- Do not put the Bearer token in URLs or logs. Artifact iframes keep exactly `sandbox="allow-scripts allow-popups"`.
- Korean copy must be exact as written in this plan.
- Plan 1 and Plan 2 behavior keeps passing:
  - root `cargo test --workspace -- --test-threads=1`
  - `apps/desktop` `test` / `build` / `e2e`
  - `src-tauri` `cargo test`
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.superpowers/`.

## Review Focus

1. **A user edited ONBOARD.md.** roomsd must not clobber a file without a marker. Upgrading from marker v1 to v2 rewrites the file.
2. **Moving a link keeps its day.** After `move_artifact`, the artifact keeps the same `createdAt` and Journal day, even though its id changes.
3. **Moving a regular file vs a symlink out of inbox.** Both are a `rename` inside Home. A broken symlink or a directory is refused.
4. **Script robustness on real logs.** Truncated JSON lines, missing fields and huge files must not crash it. The 14-day prune must not read every file.
5. **Re-run idempotence.** A second "rooms 정리해줘" must not create duplicate links for originals that are already linked anywhere under `~/rooms`. `find_html.py` marks each candidate `linked: true` by scanning symlink targets under Home.

---

### Task 1: `move_artifact` in core and roomsd, plus the client

**Files:**
- Modify: `crates/rooms-core/src/{core.rs,index.rs}`, `crates/roomsd/src/{lib.rs,routes.rs}`, `packages/protocol-ts/src/client.ts`
- Test: `crates/rooms-core/tests/core_flows.rs`, `crates/roomsd/tests/api.rs`

**Interfaces:**
- `RoomsCore::move_artifact(&self, from_room: &RoomId, artifact_id: &str, to_room: &RoomId) -> Result<Artifact, CoreError>`
  1. Both rooms must be owned and exist. `from` may be `inbox`. `to` must not be `inbox`, and `to != from`. Otherwise return `InvalidInput`. A missing room returns `RoomNotFound`.
  2. Find the artifact by id in `from`. If it is missing, return `NotFound`.
  3. Locate `<from_root>/<rel_path>` and take `symlink_metadata`. It must be a regular file or a symlink whose target is an existing html file. Otherwise return `InvalidInput`.
  4. Pick the target name `<to_root>/<basename>`. On a collision, use ` (2)`, ` (3)` and so on.
  5. Take the per-room scan locks for both rooms in **room-id order** (to avoid deadlock), and never take a scan lock while holding Inner.
  6. `fs::rename`.
  7. Under Inner, call `index.reassign(from, rel, to, new_rel)`. It deletes the old row and inserts a new row with the **same `created_at`/`created_day`/`created_ts`**, a new id and a new `rel_path`. It emits `artifact.removed` (from), then `artifact.added` (to), then `journal.changed` for that day.
  8. Return the new Artifact.
- `Index::reassign(&mut self, from_room: &str, from_rel: &str, to_room: &str, to_rel: &str) -> Result<(Change, Change), CoreError>`, run as one transaction.
- `POST /v1/artifacts/move` with JSON `{ "roomId": string, "artifactId": string, "toRoomId": string }`, returning `Artifact`. It sits behind the write guard.
- TS: `moveArtifact(roomId: string, artifactId: string, toRoomId: string): Promise<Artifact>`.

- [ ] **Step 1: Write the failing tests**
  - **core_flows:**
    - Moving a symlink from inbox to room `a` keeps `created_at` and the Journal day. The source no longer lists it and `a` does. The original file is untouched (same inode and contents).
    - A name collision gets ` (2)`.
    - Moving from or to a linked room returns `InvalidInput`, and nothing is written into the linked folder.
    - Moving to journal or inbox returns `InvalidInput`.
    - A broken symlink returns `InvalidInput`.
    - A missing id returns `NotFound`.
  - **api:**
    - Success returns 200 with the new artifact.
    - No token returns 403.
    - Linked returns 400.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `cargo test --workspace -- --test-threads=1` and `bunx -p typescript tsc --noEmit -p packages/protocol-ts`.
- [ ] **Step 5: Commit** with `feat(core): move an artifact between owned rooms, keeping its first-seen time`.

---

### Task 2: The `find_html.py` script (deterministic candidate extraction)

**Files:**
- Create: `crates/rooms-core/assets/onboarding/skill/rooms/scripts/find_html.py`
- Create: `crates/rooms-core/assets/onboarding/skill/rooms/scripts/test_find_html.py`
- Create: `crates/rooms-core/assets/onboarding/skill/rooms/scripts/fixtures/` (synthetic Claude Code and Codex jsonl; no real user data)

**Interfaces:**
- CLI: `python3 find_html.py [--days 14] [--home ~/rooms] [--claude-dir ~/.claude/projects] [--codex-dir ~/.codex/sessions] [--include-noise]`. It prints JSON to stdout:
  ```json
  {"version":1,"days":14,"generated_at":"<iso>",
   "candidates":[{"path":"/abs/real.html","title":"<title or basename>","agent":"claude-code|codex",
                  "first_written":"<iso>","last_written":"<iso>","sessions":["<id>"],"cwd":"/abs",
                  "repo_key":"<repo or dir>","rel_in_repo":"docs/x.html","linked":false,"linked_at":[]}],
   "skipped":{"noise":12,"missing":14,"read_errors":0}}
  ```
- Rules:
  - Python 3.9+ stdlib only.
  - Stream lines.
  - Prefilter on the substring `.htm` before `json.loads`.
  - Skip any line that fails to parse, and count it.
  - Claude Code: prune by file mtime older than the window.
  - Codex: prune by the `YYYY/MM/DD` directory names, and also include `~/.codex/archived_sessions/*.jsonl` by mtime.
  - The title comes from `<title>` within the first 64 KB; fall back to the basename.
  - `linked` / `linked_at`: walk `--home` for symlinks, without following directory links, and compare each target's realpath.
  - Exit 0 even when no logs exist, with empty candidates.
  - The script must never write anything.
- Tests use `unittest`, run with `python3 -m unittest discover -s <scripts dir>`. Cover:
  - Claude Write, Edit and Artifact entries are counted; Read is not.
  - The Codex apply_patch absolute path, and the relative shell path resolved against cwd.
  - Records older than 14 days are excluded.
  - A missing file goes to `skipped.missing`.
  - A noise path is skipped unless `--include-noise` is passed.
  - Two worktree copies share a `repo_key`.
  - An already-linked original gets `linked: true`.
  - A truncated JSON line does not crash the script.

- [ ] **Step 1: Write the fixtures and failing tests.**
- [ ] **Step 2: Run them and confirm they fail** (no script yet).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s crates/rooms-core/assets/onboarding/skill/rooms/scripts -v`. Also run it once read-only against this machine's real logs and record **counts only** in the report. Do not paste any user paths or content beyond redacted examples.
- [ ] **Step 5: Commit** with `feat(onboarding): find_html.py extracts recent .html writes from agent logs`.

---

### Task 3: ONBOARD.md and SKILL.md content, and roomsd writing them on open

**Files:**
- Create: `crates/rooms-core/assets/onboarding/ONBOARD.md`
- Create: `crates/rooms-core/assets/onboarding/skill/rooms/SKILL.md`
- Create: `crates/rooms-core/src/onboarding.rs`
- Modify: `crates/rooms-core/src/{lib.rs,core.rs}` so that `open` calls `onboarding::ensure(&home)`. If it fails, log a warning and continue; never fail `open` because of it.
- Test: unit tests in `onboarding.rs`.

**Interfaces:**
- `pub fn ensure(home: &Path) -> std::io::Result<()>`
  - Embed with `include_str!`.
  - Write each file atomically (temp file + rename) when the file is missing, or when its first line is a marker with a lower version.
  - Never overwrite a file whose first line is not a marker.
  - Set `find_html.py` to mode 0755 and the other files to 0644.
- **ONBOARD.md content** (Korean, written for an agent). In order:
  1. Say what Rooms is in two sentences.
  2. Detect which agent you are:
     - Claude Code: copy `~/rooms/.rooms/onboarding/skill/rooms/` to `~/.claude/skills/rooms/`.
     - Codex: copy it to `~/.codex/skills/rooms/`.
     - Otherwise, ask the user where your skills live. If there is no skill system, just follow SKILL.md directly.
  3. Never overwrite an existing `~/.claude/skills/rooms` that lacks the marker. Ask first.
  4. Then follow SKILL.md's "처음 정리" section.
- **SKILL.md** frontmatter:
  - `name: rooms`
  - `description:` triggers including "rooms 정리해줘", "~/rooms/ONBOARD.md", "방에 정리", "Rooms에 넣어줘", and "HTML 아티팩트를 만들었을 때"
- **SKILL.md** sections:
  - "처음 정리 / 다시 정리":
    1. Run `python3 <skill>/scripts/find_html.py --days 14`. Use `--days 30` when the user asks for more.
    2. Show the user, **once**, the candidates grouped by `repo_key` (counts and top folders), with linked ones excluded.
    3. Read titles and the head of each file, then propose topic rooms: names, and which files go where. Unsure files go to inbox.
    4. Ask the user to confirm once.
    5. `mkdir -p ~/rooms/<slug>` (NFC, spaces → `-`; never `journal`/`inbox`/a leading `.`).
    6. `ln -s <original> ~/rooms/<slug>/<basename>`, inserting ` (2)` on a collision.
    7. Report what was created, and remind the user that originals were not moved.
  - Re-run behavior: skip `linked: true`.
  - "만들 때마다 (습관)": after writing any `.html` artifact, link it into the best room, or into inbox when unsure. Do this instead of copying.
  - "한 줄 추가 (묻고 나서만)": at the end of the first onboarding, ask whether to add this one line to `~/.claude/CLAUDE.md` (or `~/.codex/AGENTS.md`), and add it only on yes: `- HTML 아티팩트를 만들면 rooms 스킬로 알맞은 방에 링크한다.`
  - "하지 말 것":
    - Never move, edit or delete originals.
    - Never write inside linked-folder rooms.
    - Never create rooms named `journal` or `inbox`.
    - Never touch `~/rooms/.rooms`, except reading the skill source.
    - Never include tokens.
- Tests:
  - A missing file is written.
  - An older marker is upgraded.
  - A file without a marker is left untouched.
  - The modes are correct.
  - `open` succeeds even when Home is read-only for these files (simulate by making `.rooms/onboarding` a file and confirm `open` still returns Ok).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the content and `ensure`.**
- [ ] **Step 4: Run `cargo test --workspace -- --test-threads=1`** and the Python tests.
- [ ] **Step 5: Commit** with message `feat(onboarding): ONBOARD.md and rooms skill written into Home by roomsd`.

---

### Task 4: Desktop: onboarding card, "방을 기다리는 문서", and drag to move

**Files:**
- Modify: `apps/desktop/src/views/NewTabView.tsx`, `apps/desktop/src/shell/Sidebar.tsx`, `apps/desktop/src/views/RoomView.tsx` / `ArtifactCard.tsx` (draggable when the room is inbox), `apps/desktop/src/lib/errors.ts`
- Create: `apps/desktop/src/views/OnboardingCard.tsx`
- Test: `*.test.tsx` next to each changed file.

**Interfaces and copy (exact):**
- `OnboardingCard({ compact })`:
  - **Full form** (when no rooms other than inbox exist): the New tab body is replaced, apart from its header area, by:
    - h1 "이 한 줄을 에이전트에게 붙여넣으세요" (32px/500)
    - subtitle "에이전트가 최근 14일 동안 만든 HTML을 주제별 방으로 정리해요. 원본은 그대로 두고 링크만 만들어요." (17px #6a6a6a)
    - a mono chip with text `~/rooms/ONBOARD.md 를 읽고 따라 해줘`. When `info.home` is not `~/rooms`, show `<home with ~>/ONBOARD.md 를 읽고 따라 해줘`. Clicking it copies the text and shows "복사했어요" for 1.5 s.
    - below the chip, the quiet line "Claude Code나 Codex에 붙여넣으면 돼요." (14px #929292)
  - **Compact form**, shown at the top of the New tab when rooms exist and the user opened it via the sidebar link:
    - "에이전트로 다시 정리하기" (15px/500)
    - the chip `rooms 정리해줘`, with the same copy behavior
    - Dismissed when the user leaves the tab.
- **Sidebar:** under the room list, a quiet 13px `#929292` text button "에이전트로 정리하기". It opens or activates the New tab with the compact card. Hidden when read-only.
- **New tab "방을 기다리는 문서"** (h2 18px/500):
  - shown only when the inbox has artifacts
  - one row per inbox artifact: title 16px/500, then the date label (mono 12px #929292)
  - rows are draggable
  - a hint line "카드를 왼쪽 방에 끌어다 놓으면 옮겨져요" (13px #929292)
  - clicking a row opens the doc tab
- **Inbox room view:** cards are also draggable.
- **Drag and drop:**
  - Use the HTML5 drag API with data type `application/x-rooms-artifact` and JSON payload `{roomId, artifactId}`.
  - Sidebar owned-room rows (not inbox, not linked, not unavailable) are drop targets: hover background `#ebebeb` plus a 1px ink outline.
  - On drop, call `client.moveArtifact(...)`. On success, show nothing extra; the SSE events update both lists.
  - On error, show the `errorCopy` copy as a 3 s brief error near the sidebar. Add the code `invalid_input` → "옮길 수 없는 문서예요".
- **First run:** "no rooms" means `rooms.filter(r => r.id !== "inbox").length === 0`, evaluated after the first sync. Before that, render nothing, not the card.

- [ ] **Step 1: Write the failing tests:**
  - With an empty room list, the full card shows with exact copy, and clicking copies the prompt.
  - With rooms present, the subtitle reads "지난 방문 이후".
  - The sidebar link opens the compact card.
  - With inbox items, "방을 기다리는 문서" lists them.
  - Firing drag/drop events onto a sidebar room calls `moveArtifact` with the right payload.
  - Dropping onto a linked room or onto inbox is not allowed: no call.
  - An error shows the copy.
  - In read-only mode, there is no drag source, no drop target and no sidebar link.
- [ ] **Step 2: Run the tests** and watch them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run --cwd apps/desktop test` and `build`.**
- [ ] **Step 5: Commit** with the message `feat(desktop): onboarding prompt, inbox waiting list, drag to move`.

---

### Task 5: E2E, docs and a dry run of the skill flow

**Files:**
- Modify: `apps/desktop/e2e/*.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-05-alto-rooms-v1-manual-test.html`
- Modify: `docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-followups.md`

**Steps:**
- [ ] **e2e:**
  - On a fresh home, the New tab shows "이 한 줄을 에이전트에게 붙여넣으세요", and `<home>/ONBOARD.md` exists with the marker.
  - Create a symlink in `<home>/inbox` to an original outside home. Drag its row onto room "a" (Playwright `dragTo`). The link is now in `<home>/a/`, the original is untouched, and the Journal day stays the same.
- [ ] **Skill dry run** (no agent, scripted):
  1. Run `find_html.py --claude-dir <fixtures> --home <tmp home>`.
  2. Simulate the agent's steps (`mkdir` + `ln -s`) from its JSON.
  3. Start roomsd on test ports and confirm the rooms and links appear with the right Journal days.
  4. Re-run `find_html.py` and confirm everything is `linked: true`.

  Write this as a shell script `crates/rooms-core/assets/onboarding/skill/rooms/scripts/dry_run.sh`. It is not shipped to users, so exclude it from `ensure`.
- [ ] **Manual test doc:** add an "온보딩" scenario: paste the one-liner into Claude Code, confirm the proposed rooms, check the rooms appear and the originals are untouched, re-run "rooms 정리해줘" to get no duplicates, then drag from inbox.
- [ ] **Follow-ups:** add the parked items found during this plan.
- [ ] **Commit** with message `test(onboarding): e2e for first-run card and inbox move; skill dry run; docs`.
