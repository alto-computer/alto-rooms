# Alto Rooms v2.1 — Link Docs to the Thread That Made Them (sources.json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Asking about a doc that has no `rooms:*` meta resumes the conversation that wrote it, using a provenance file the rooms skill records deterministically.

**Architecture:** `find_html.py --record-sources` (stdlib Python, already parses Claude Code / Codex logs) merges `{realpath: {agent, session, cwd, writtenAt}}` into `<home>/.rooms/sources.json`. The rooms skill (v5) runs it at first sort, re-sort and every link. roomsd's `Asks::start` reads the file only when the doc has no valid `rooms:session` meta. The ask sheet says when it had to fall back to a new conversation.

**Tech Stack:** Python 3 stdlib + unittest; Rust (serde_json); React/vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-alto-rooms-v2-ask-spec.html` §12 (and §2 R0–R3 for validation).

## Global Constraints

- Rooms core never parses agent logs; it only reads `sources.json`.
- `sources.json` shape: `{"version": 1, "sources": {"<abs realpath>": {"agent": str, "session": str, "cwd": str, "writtenAt": "<ISO-8601 UTC, find_html's fmt()>"}}}`.
- Writer merges: same path is replaced only if the new `writtenAt` >= the stored one; unreadable/invalid file → start from empty; write to a temp file in the same dir then `os.replace` (atomic). Candidates without a session are not recorded. Value = the candidate's LAST write (agent, session, cwd).
- Reader (roomsd): read the file on every ask (no cache); missing or invalid → no entry. Meta wins: use the sidecar only when the doc's `rooms:session` is absent or fails `valid_ident`. Use the sidecar entry WHOLE (agent, session, cwd together) — never mix meta agent with sidecar session. The entry's values still go through R0 (`valid_ident` for agent/session; cwd absolute + existing dir else the doc's folder).
- Key = the doc's realpath = `RoomsCore::resolve_file(...)` result (already canonicalized) = `os.path.realpath` in find_html.
- Skill/ONBOARD marker bumps from `rooms-onboarding v4` to `rooms-onboarding v5` everywhere (SKILL.md, ONBOARD.md, find_html.py header) so installed copies self-update.
- UI copy is English. New-mode sheet header: `{agent} · new conversation — couldn't find the thread that made this doc`.
- Commits: repo identity (jun-hash); message ends with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A doc linked before v5 (already `linked: true`) must still get recorded by `--record-sources` — test in Task 1.
- A doc whose meta has `rooms:agent=codex` but no session must use the sidecar entry whole (its agent too), not codex + sidecar session — test in Task 3.
- A corrupt `sources.json` must neither crash find_html (it rewrites) nor fail an ask (falls back to new) — tests in Tasks 1 and 3.
- An older log scan must not overwrite a newer recorded entry — test in Task 1.

---

### Task 1: `find_html.py --record-sources`

**Files:**
- Modify: `crates/rooms-core/assets/onboarding/skill/rooms/scripts/find_html.py` (argparse ~l.389, end of `main`)
- Modify: `crates/rooms-core/assets/onboarding/skill/rooms/scripts/test_find_html.py`

**Interfaces:**
- Produces: CLI flag `--record-sources`; output JSON gains `"recorded": <int>` (number of entries written or updated this run) only when the flag is set. Helper `record_sources(rooms_home: str, cands: list[dict], writes_by_path: dict) -> int`.

- [ ] **Step 1: Tests first** — add to `test_find_html.py`, using its existing `Env` helper (read it first to build a fake Claude log that writes an HTML file with a session id and cwd):
  - `--record-sources` writes `<home>/.rooms/sources.json` with the doc's realpath → `{agent: "claude-code", session: <sid>, cwd: <cwd>, writtenAt: <last_written>}`, and output has `recorded == 1`.
  - A candidate that is already linked into a room (`linked: true`) is still recorded.
  - Two sessions wrote the same file: the LAST write's session is recorded.
  - An existing entry with a NEWER `writtenAt` is kept (not overwritten); an equal or older one is replaced.
  - A corrupt `sources.json` (`"{"`) is replaced by a valid file containing the new entries.
  - Without the flag, `sources.json` is not created and output has no `recorded` key.
- [ ] **Step 2:** run `python3 -m unittest crates/rooms-core/assets/onboarding/skill/rooms/scripts/test_find_html.py -v` → new tests FAIL.
- [ ] **Step 3: Implement.** In `main`, keep the per-candidate last write (`last = writes[-1]`, fields: time, agent, session, cwd). After building `cands`, if `a.record_sources`: build `{c["path"]: {"agent": last[1], "session": last[2], "cwd": last[3] or dirname(path), "writtenAt": fmt(last[0])}}` for candidates whose last write has a session; merge into the existing file per Global Constraints (compare ISO strings — same `fmt()` format, so lexical order is time order); `os.makedirs(<home>/.rooms, exist_ok=True)`; write `json.dumps({"version": 1, "sources": merged}, ensure_ascii=False, indent=1, sort_keys=True)` to `sources.json.tmp` then `os.replace`. Add `"recorded"` to the output object. Update the module docstring to mention the flag and that it is the only thing the script writes.
- [ ] **Step 4:** tests PASS; also run the whole file.
- [ ] **Step 5: Commit** "Record which conversation wrote each artifact into sources.json".

### Task 2: Skill v5 + ONBOARD v5

**Files:**
- Modify: `crates/rooms-core/assets/onboarding/skill/rooms/SKILL.md`, `crates/rooms-core/assets/onboarding/ONBOARD.md`, `find_html.py` header marker
- Modify: `crates/rooms-core/src/onboarding.rs` tests (l.~112-117 assert `v4`)

- [ ] **Step 1:** change the three markers to `rooms-onboarding v5`; update `onboarding.rs` tests to expect v5; run `cargo test -p rooms-core onboarding` (FAIL first if you change tests first).
- [ ] **Step 2: SKILL.md text** (keep its style, English):
  - First sort / re-sort step 1: the command becomes `python3 "<skill>/scripts/find_html.py" --home "<home>" --days 14 --record-sources`, and a sentence: "This also records which conversation wrote each file (`<home>/.rooms/sources.json`), including files already in a room, so asking about a doc in Rooms continues that conversation."
  - Re-sort: note that re-running is how existing docs get linked to their conversation; nothing is moved.
  - "Every time you write one (habit)" step 1: use `--days 1 --record-sources`.
  - "Never" section: replace "Never touch `<home>/.rooms`…" with "Never touch `<home>/.rooms` by hand. Exceptions: reading the skill source, and `find_html.py --record-sources`, which writes only `<home>/.rooms/sources.json`."
- [ ] **Step 3: ONBOARD.md:** if it repeats the find_html command or the never-touch rule, update them the same way; bump marker.
- [ ] **Step 4:** `cargo test -p rooms-core` (onboarding tests + everything) PASS.
- [ ] **Step 5: Commit** "Rooms skill v5: record source conversations when sorting and linking".

### Task 3: roomsd reads `sources.json` when a doc has no meta

**Files:**
- Create: `crates/rooms-core/src/asks/sources.rs`
- Modify: `crates/rooms-core/src/asks/mod.rs` (`start`, ~l.119-125; add `pub(crate) mod sources;`)
- Modify: `crates/rooms-core/tests/asks.rs`

**Interfaces:**
- Produces: `pub(crate) fn lookup(home: &Path, file_realpath: &Path) -> Option<rooms_protocol::Source>` — reads `<home>/.rooms/sources.json`, returns `Source { agent, session, cwd, machine: None }` for the exact key, `None` on missing file / invalid JSON / missing key.

- [ ] **Step 1: Tests first.**
  - Unit (sources.rs): valid file → entry; missing file → None; `"{"` → None; other path → None.
  - Integration (tests/asks.rs, reuse `setup`): write `<home>/.rooms/sources.json` keyed by the doc's realpath (`std::fs::canonicalize`) with `{agent: "claude-code", session: "S-9", cwd: <a real temp dir>}` for a doc with NO meta → turn mode `resume`, answer argv contains `[resume] [S-9]`, `CWD:` is that temp dir.
  - Meta wins: doc with meta session `S-1` + sidecar `S-9` → `[S-1]`.
  - Whole-entry rule: doc meta `rooms:agent=codex` without session, sidecar `{agent: "claude-code", session: "S-9"}` → runs the claude-code profile in resume with `S-9` (fake agent prints `[resume] [S-9]`).
  - Sidecar values still validated: sidecar session `--bad` → new mode.
  - Corrupt sidecar → new mode, no error.
- [ ] **Step 2:** `cargo test -p rooms-core --test asks` → new tests FAIL.
- [ ] **Step 3: Implement.** In `start`, after `file_abs`:
  ```rust
  let meta = &artifact.source;
  let meta_has_session = meta.session.as_deref().is_some_and(valid_ident);
  let sidecar = if meta_has_session { None } else { sources::lookup(core.home(), &file_abs) };
  let src = sidecar.as_ref().unwrap_or(meta);
  ```
  and keep the existing `agent` / `session` / `cwd` derivation from `src` unchanged (so R0 applies to sidecar values). Comment why the entry is used whole.
- [ ] **Step 4:** `cargo test -p rooms-core` PASS (known build-env flake `open_returns_before_backfill_completes_for_big_room` may need a rerun).
- [ ] **Step 5: Commit** "Resume the writing conversation from sources.json when a doc has no meta".

### Task 4: Say when the thread couldn't be found

**Files:**
- Modify: `apps/desktop/src/ask/AskBar.tsx` (~l.193), `apps/desktop/src/ask/AskBar.test.tsx`, `apps/desktop/e2e/ask.spec.ts` (~l.40)

- [ ] **Step 1:** update/add tests: new-mode header text is exactly `claude-code · new conversation — couldn't find the thread that made this doc`; resume header unchanged.
- [ ] **Step 2:** change the header string for `mode === "new"`; keep `text-ink-2`, single line, let it wrap naturally.
- [ ] **Step 3:** `cd apps/desktop && bunx tsc -b && bunx vitest run src/ask && bun run e2e -- ask.spec.ts` PASS.
- [ ] **Step 4: Commit** "Say when an ask couldn't find the thread that made the doc".
