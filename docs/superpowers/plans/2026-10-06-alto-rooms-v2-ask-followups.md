# v2 ask — follow-ups

Deferred minor findings and rulings from the subagent-driven execution of `2026-10-06-alto-rooms-v2-ask.md` (final review clean at dfc98e1). Triage before or after merge.

## Rulings
- Ruling: T6 tests write doc files via `core.room_root(&room.id).unwrap().0` instead of `room.path` — matches T7 and avoids depending on Room.path format — costs nothing if wrong (both point to the same folder).
- Ruling: work in-place on feat/v2-ask instead of a new worktree — the branch is not main and switching the main checkout would hide the spec symlinked into ~/rooms/alto — cost if wrong: none for isolation (no other session uses this checkout).
- Ruling: astack:change per task (user CLAUDE.md) skipped — no astack skills installed in this session — user can run it later over the ledger's commit ranges.
- Ruling: batch Tasks 3+4 into one dispatch/review — both are small, independent pure modules with complete plan code — cost if wrong: one larger review surface
- Ruling: Task 5 Important (plan-mandated code) post-EOF child.wait/err_task not bounded by timeout/cancel — fix it now: spec R8 makes the 600 s bound and cancel/shutdown binding and Task 6 slots depend on it — cost if wrong: a few lines more in run.rs
- Ruling: T10 tests must await renderWithStores (it is async) — plan's sync setup() is a plan defect — cost if wrong: none
- Ruling: batch Tasks 8+9 into one dispatch — T8 is 3 client lines that T9 consumes directly — cost if wrong: none
- Ruling: spec §1 "에이전트 설정 없음 + 설정 파일 경로" header is covered by the 422 agent_config inline error (message includes the agents.toml path) — no turn exists in that case so no sheet header — cost if wrong: one extra UI string later
- Final review: With fixes. Ruling: one fix wave covering I1 claude --setting-sources=user (verified flag exists), I2 login_path off the startup path, I3 lossy per-line log read, I4 blocking() for ask routes, shutting_down flag, AskBar !thread?.loaded, in-flight send guard, readOnly textarea + refocus, login_path sentinel, first-loop child.wait race — chosen as the merge-blocking set — cost if wrong: small extra diff
- Ruling: declined items (GET /v1/asks unguarded, -l without -i, SIGKILL orphans, prompt Q/A injection, aside real-session) stay as spec says — they follow the approved spec; chip agent mismatch + e2e F2/F4 gaps + leftover descendants deferred — cost if wrong: follow-up work
- Ruling: fold the Important + both minors into the still-running fix agent (with the English-copy change) and run one scoped re-review over c15d562..HEAD — the orphan contradicts spec S6 "no orphans" — cost if wrong: one more small diff
- Ruling: CLAUDE.md in an untrusted cwd still read by claude --setting-sources=user — accepted (read-only tools) — cost if wrong: prompt-injection in an answer only

## Deferred minors
- Task 1: minor (deferred): shape test does not round-trip AskTurn or serialize done/failed/cancelled
- Task 2: minor (deferred): load does not require {prompt} in new / {session} in resume templates
- Task 2: minor (deferred): dead_code warnings in asks until Task 6 (confirm cleared)
- Task 4: minor (deferred): log read fails whole file on invalid UTF-8 line (read bytes + lossy per line)
- Task 4: minor (deferred): crash mid-write leaves no trailing newline, next record glued and skipped
- Task 4: minor (deferred): existing asks dir perms not tightened to 0700
- Task 4: minor (deferred): read is O(n^2) via find per line
- Task 5: minor (deferred): empty argv panics (return InvalidInput)
- Task 5: minor (deferred): SIGKILL only if leader alive after grace; SIGTERM-trapping grandchild may survive
- Task 5: minor (deferred): clean_output leaves OSC payloads; unused peekable
- Task 5: minor (deferred): lossy decode after byte truncation can exceed max_stdout by 2 bytes
- Task 5: minor (deferred): timeout_and_too_long lacks outer timeout; no test for missing absolute argv0
- Task 5: minor (deferred): signal-killed leader reports code -1
- Task 5: minor (deferred): normal-exit stderr tail capped at 200 ms may truncate late stderr; descendants outliving leader on normal exit are not killed
- Task 6: minor (deferred): permission-denied spawn message differs from spec table wording
- Task 6: minor (deferred): list_artifacts/resolve_file errors all map to NotFound (IO faults show as 404)
- Task 6: minor (deferred): emit_ask public, accepts any EventKind (debug_assert only)
- Task 6: minor (deferred): running lock held across append + spawn
- Task 6: minor (deferred): no facade tests for shutdown->cancelled, TooLong message, cwd fallback
- Task 7: minor (deferred): POST during the 700 ms shutdown window can spawn an unkilled group (add shutting_down flag)
- Task 7: minor (deferred): ask handlers run sync core IO on async workers (spawn_blocking if it stalls)
- Task 7: minor (deferred): no route tests for 409 busy/capacity or read-only DELETE
- Task 7: minor (deferred): login_path() can delay serving up to 2 s after bind — check desktop readiness wait tolerates it
- Task 9: minor (deferred): asksStore tests miss negatives (non-null resync, unloaded thread, other fileKey); cancel-swallow test does not prove catch
- Task 9: minor (deferred): redundant type check in onSignal handler; load failure sets loaded:true (AskBar retries via error)
- Task 10: minor (deferred): disabled textarea while running blocks Esc fold and loses focus; no refocus after finish
- Task 10: minor (deferred): no in-flight guard, fast double Enter sends twice (2nd gets ask_busy)
- Task 10: minor (deferred): scroll-to-bottom not on sheet unfold
- Task 10: minor (deferred): no tests for load-failure retry, copy button
- Task 11: minor (deferred): no test for read-only ignore or non-Tauri page ⌘J from input
- Task 11: minor (deferred): build_menu doc comment omits 묻기 바 ⌘J; appEvents comment says "Ask Bar"
- Task 12: minor (deferred): reload step does not re-assert header; openDocTab duplicates rooms.spec flow; TOML path unescaped

## Next
- Follow-up (user-approved 2026-10-06): provenance sidecar — rooms skill records {realpath: {agent, session, cwd}} into <home>/.rooms/sources.json at sort/re-sort (including already-linked files) and at link time; roomsd uses it when a doc has no rooms:* meta; UI says when it falls back to a new conversation. Root cause: onboarding found sessions (find_html.py) but the design never recorded them (spec §11 open question).
