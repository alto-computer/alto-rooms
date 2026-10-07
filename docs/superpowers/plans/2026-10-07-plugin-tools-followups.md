# Plugin tools — follow-ups

From the subagent-driven execution of `2026-10-07-plugin-tools.md` (final review clean after fix wave; e2e verified in dev: a real claude ask drew via rooms-mcp).

## Release steps (need owner approval — publishing)
- Publish plugin SDK 0.2.0; switch rooms-plugin-excalidraw's SDK dependency from the local file: path to the release tarball.
- Bump the app to 0.5.0 together with apps/desktop/bundled-plugins.json (excalidraw 0.2.0 + sha256).
- Verify rooms-mcp sits next to roomsd in a built .app (Contents/MacOS).
- Publish the excalidraw 0.2.0 release zip.

## Rulings
- Ruling: user said "구현해줘 좋아" after approving the design in chat; proceeding from the written spec without a separate spec-review stop — cost if wrong: spec edits mid-way
- Ruling: malformed doc (not 16-hex and not absolute) → 400 bad_request; well-formed but unknown → 404 — constraints define the doc shape; spec T2 "resolution failure" means a well-formed value — cost if wrong: one status code
- Final review: With fixes. Ruling: one fix wave = I1 require input.type=="object" (+ rooms-mcp normalise backstop); I2 --strict-mcp-config in claude templates; ureq timeouts + default-features=false; absolute ROOMS_MCP_BIN; plugin opsApplied after updateScene; list_tools comment + appendTo append-only note; T6 unmount test, T5 fileKey assert; spec note on Drawing… copy and ops 10 MiB limit — cost if wrong: small diff
- Ruling: release steps (publish SDK 0.2.0, switch plugin dep to tarball, bump app 0.5.0 with bundled pin, verify built .app sidecar placement) are user-gated (publishing/outward) — surfaced to user, not done
- Ruling: deferred — ops compaction, resync relay, minAppVersion check in core, tool approval on enable card, cross-doc draw

## Deferred minors
- Task 0: minor (deferred): no test for room-symlink write merging into the original; candidate fields may change for outside files via room symlinks; --include-noise --record-sources records .rooms; in-home files not counted in skipped
- Task 1: minor (deferred): weak contains() assertions in manifest tool tests; whitespace-only description accepted; 16 KiB boundary untested
- Task 3: minor (deferred): oversize body (>2MB axum) maps to 400 not 413 (compliant, add comment); no route test for >64KiB input; brittle prefix slicing
- Task 2: minor (deferred, fix in final wave): O_NOFOLLOW on append open; "is a folder" message for symlink; list_tools doc comment says manifest order but it is alphabetical; double plugin scan; bridge rewrite can drop an append (document appendTo files as append-only); tests: symlinked room folder, exact 10 MiB boundary
- Task 4: minor (fix in final wave): invalid UTF-8 line ends session; home_dir expect panic; no ureq timeouts (could hang); ureq default TLS features; inputSchema not normalized to type:object; protocolVersion echoed unchecked; tests for ping/missing name/no-method
- Task 5: minor (fix in final wave): relative ROOMS_MCP_BIN written verbatim (absolutize); mcp.json write non-atomic; add {mcp_config} to single-pass test; assert actual fileKey in prompt test
- Task 6: minor (fix in final wave): unmount test is vacuous (spy onSignal unsubscribe instead); dataChanged posted before ready (harmless)
- Task 7: minor (deferred): opsApplied advanced before updateScene; overlapping fadeIn shares fading set; legacy flattened edge customData
