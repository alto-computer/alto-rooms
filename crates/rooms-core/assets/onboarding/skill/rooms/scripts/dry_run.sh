#!/usr/bin/env bash
# Scripted dry run of the rooms onboarding skill, with no agent.
#
# Dev-only: NOT embedded by rooms-core (onboarding.rs embeds only ONBOARD.md,
# SKILL.md and find_html.py) and never written into a user's Home.
#
#   1. Builds a temp world: a Rooms home, a fake Claude projects dir with one
#      synthetic session log that wrote 3 .html originals into a temp "repo",
#      and an empty Codex dir.
#   2. Runs find_html.py against it.
#   3. Plays the agent: mkdir <home>/<slug>, ln -s 2 originals there and 1
#      into <home>/inbox, straight from find_html.py's JSON.
#   4. Starts the built roomsd on test ports 24317/24318 and checks the rooms,
#      their artifacts and the Journal day of each artifact (the original's
#      birthtime day).
#   5. Re-runs find_html.py: every candidate must be linked: true.
#   6. Links a folder room "site" through the API, writes one original inside it
#      and one inside a git worktree of the demo repo, and re-runs find_html.py:
#      in_linked_room / in_worktree must be set. Also runs the find + realpath
#      duplicate check against an already-linked original.
#
# Never touches ~/rooms, ~/.claude or ~/.codex, and never uses 4317/4318.
# Usage: bash dry_run.sh   (from anywhere; builds roomsd with cargo first)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../../../.." && pwd)"
FIND="$HERE/find_html.py"
API_PORT=24317
FILES_PORT=24318
BASE="http://127.0.0.1:$API_PORT"
HOSTH="host: 127.0.0.1:$API_PORT"

ROOT=""
PID=""
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [ -n "$ROOT" ]; then rm -rf "$ROOT"; fi
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/Cargo.toml" ] || fail "repo root not found at $REPO_ROOT"
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
cargo build -q -p roomsd --manifest-path "$REPO_ROOT/Cargo.toml"
ROOMSD="$REPO_ROOT/target/debug/roomsd"
[ -x "$ROOMSD" ] || fail "roomsd not built at $ROOMSD"

for p in $API_PORT $FILES_PORT; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/"; then fail "port $p is busy"; fi
done

# --- 1. temp world -----------------------------------------------------------
ROOT="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/rooms-dryrun-XXXXXX")" && pwd -P)"
USER_HOME="$ROOT/user"            # find_html.py's $HOME: temp paths under it are not noise
HOME_DIR="$USER_HOME/rooms"
CLAUDE_DIR="$USER_HOME/.claude/projects"
CODEX_DIR="$USER_HOME/.codex/sessions"
REPO="$USER_HOME/code/demo-repo"  # where the originals live, outside the Rooms home
mkdir -p "$HOME_DIR" "$CLAUDE_DIR/-demo-repo" "$CODEX_DIR" "$REPO/.git" "$REPO/out"

python3 - "$REPO" "$CLAUDE_DIR/-demo-repo/s1.jsonl" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone
repo, log = sys.argv[1], sys.argv[2]
lines = []
for i, name in enumerate(["alpha", "beta", "gamma"]):
    p = os.path.join(repo, "out", f"{name}.html")
    with open(p, "w") as f:
        f.write(f"<!doctype html><html><head><title>Dry {name}</title></head><body>{name}</body></html>")
    ts = (datetime.now(timezone.utc) - timedelta(minutes=10 - i)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    lines.append({"type": "assistant", "timestamp": ts, "cwd": repo, "sessionId": "dry-run",
                  "message": {"content": [{"type": "tool_use", "name": "Write", "input": {"file_path": p}}]}})
with open(log, "w") as f:
    for l in lines:
        f.write(json.dumps(l) + "\n")
PY

# Fingerprint the originals (bytes + inode) to prove they are never touched.
fingerprint() {
  python3 - "$REPO/out" <<'PY'
import hashlib, os, sys
d = sys.argv[1]
for n in sorted(os.listdir(d)):
    p = os.path.join(d, n)
    st = os.lstat(p)
    print(n, st.st_ino, hashlib.sha256(open(p, "rb").read()).hexdigest())
PY
}
BEFORE="$(fingerprint)"

find_html() {
  HOME="$USER_HOME" python3 "$FIND" --home "$HOME_DIR" --claude-dir "$CLAUDE_DIR" --codex-dir "$CODEX_DIR"
}

# --- 2. find_html.py ---------------------------------------------------------
OUT1="$ROOT/find1.json"
find_html >"$OUT1"

# --- 3. the agent's steps: mkdir + ln -s from the JSON -----------------------
python3 - "$OUT1" "$HOME_DIR" <<'PY'
import json, os, re, sys
out, home = json.load(open(sys.argv[1])), sys.argv[2]
c = out["candidates"]
assert len(c) == 3, f"want 3 candidates, got {len(c)}: {c}"
assert all(not x["linked"] for x in c), "fresh home: nothing should be linked yet"
assert {x["repo_key"] for x in c} == {"demo-repo"}, [x["repo_key"] for x in c]
assert all(x["in_linked_room"] is None and x["in_worktree"] is False for x in c), c
assert out["version"] == 2, out["version"]
slug = re.sub(r"[^a-z0-9]+", "-", c[0]["repo_key"].lower()).strip("-")
room, inbox = os.path.join(home, slug), os.path.join(home, "inbox")
os.makedirs(room, exist_ok=True)
os.makedirs(inbox, exist_ok=True)
ordered = sorted(c, key=lambda x: x["path"])
for x in ordered[:2]:
    os.symlink(x["path"], os.path.join(room, os.path.basename(x["path"])))
os.symlink(ordered[2]["path"], os.path.join(inbox, os.path.basename(ordered[2]["path"])))
PY

# --- 4. roomsd on test ports -------------------------------------------------
ROOMS_HOME="$HOME_DIR" ROOMS_API_PORT=$API_PORT ROOMS_FILES_PORT=$FILES_PORT \
  "$ROOMSD" >"$ROOT/roomsd.log" 2>&1 &
PID=$!

up=""
for _ in $(seq 1 100); do
  if curl -sf -H "$HOSTH" "$BASE/v1/info" >/dev/null 2>&1; then up=1; break; fi
  kill -0 "$PID" 2>/dev/null || { cat "$ROOT/roomsd.log" >&2; fail "roomsd exited early"; }
  sleep 0.1
done
[ -n "$up" ] || { cat "$ROOT/roomsd.log" >&2; fail "roomsd did not answer /v1/info within 10s"; }

get() { curl -sf -H "$HOSTH" "$BASE$1"; }

ROOMS_JSON="$(get /v1/rooms)"
DEMO_ID="$(python3 -c '
import json, sys
rooms = {r["name"]: r for r in json.loads(sys.argv[1])}
assert "demo-repo" in rooms, f"room demo-repo missing: {sorted(rooms)}"
assert "inbox" in rooms, f"room inbox missing: {sorted(rooms)}"
assert rooms["demo-repo"]["artifactCount"] == 2, rooms["demo-repo"]
assert rooms["inbox"]["artifactCount"] == 1, rooms["inbox"]
print(rooms["demo-repo"]["id"])
' "$ROOMS_JSON")" || fail "rooms listing: $ROOMS_JSON"
INBOX_ID="$(python3 -c '
import json, sys
print([r for r in json.loads(sys.argv[1]) if r["name"] == "inbox"][0]["id"])' "$ROOMS_JSON")"

ROOM_ARTS="$(get "/v1/rooms/$DEMO_ID/artifacts")"
INBOX_ARTS="$(get "/v1/rooms/$INBOX_ID/artifacts")"
DAYS="$(python3 - "$ROOM_ARTS" "$INBOX_ARTS" "$REPO/out" <<'PY'
import json, os, re, sys
from datetime import datetime
def parse(ts):  # roomsd emits nanoseconds; datetime takes at most microseconds
    return datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", ts))
room, inbox, out = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
assert len(room) == 2, f"demo-repo artifacts: {room}"
assert len(inbox) == 1, f"inbox artifacts: {inbox}"
assert {a["title"] for a in room + inbox} == {"Dry alpha", "Dry beta", "Dry gamma"}, [a["title"] for a in room + inbox]
for a in room + inbox:
    st = os.stat(os.path.join(out, os.path.basename(a["relPath"])))
    born = getattr(st, "st_birthtime", st.st_mtime)
    day = datetime.fromtimestamp(born).strftime("%Y-%m-%d")
    created_at = parse(a["createdAt"])
    assert abs(created_at.timestamp() - born) < 1, f"{a['relPath']}: createdAt {a['createdAt']} is not the original's birthtime"
    created = created_at.astimezone().strftime("%Y-%m-%d")
    assert created == day, f"{a['relPath']}: createdAt day {created} != original's birthtime day {day}"
    print(day, a["id"])
PY
)" || fail "artifact listing: $ROOM_ARTS / $INBOX_ARTS"

while read -r day id; do
  JDAY="$(get "/v1/journal/$day")"
  python3 -c '
import json, sys
ids = [a["id"] for a in json.loads(sys.argv[1])["artifacts"]]
assert sys.argv[2] in ids, f"{sys.argv[2]} not on Journal {sys.argv[3]}: {ids}"' "$JDAY" "$id" "$day" \
    || fail "journal day $day"
done <<<"$DAYS"

# --- 5. re-run: everything is linked -----------------------------------------
OUT2="$ROOT/find2.json"
find_html >"$OUT2"
python3 - "$OUT2" "$HOME_DIR" <<'PY' || fail "second find_html.py run"
import json, sys
out, home = json.load(open(sys.argv[1])), sys.argv[2]
c = out["candidates"]
assert len(c) == 3, f"want 3 candidates, got {len(c)}"
for x in c:
    assert x["linked"] is True, f"{x['path']} not linked"
    assert len(x["linked_at"]) == 1 and x["linked_at"][0].startswith(home + "/"), x["linked_at"]
PY

# --- 6. linked-folder room + worktree ----------------------------------------
SITE="$USER_HOME/code/site"
WT="$USER_HOME/code/demo-wt"
mkdir -p "$SITE/pages" "$WT/out"
printf 'gitdir: %s/.git/worktrees/demo-wt\n' "$REPO" >"$WT/.git"
TOKEN_FILE="$HOME_DIR/.rooms/token"
LINK_STATUS="$(curl -s -o "$ROOT/link.json" -w '%{http_code}' -X POST -H "$HOSTH" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H 'content-type: application/json' \
  --data "{\"path\": \"$SITE\", \"name\": \"site\"}" "$BASE/v1/rooms/link")"
[ "$LINK_STATUS" = 200 ] || fail "link folder room: HTTP $LINK_STATUS $(cat "$ROOT/link.json")"

python3 - "$SITE/pages/delta.html" "$WT/out/eps.html" "$CLAUDE_DIR/-demo-repo/s1.jsonl" <<'PY'
import json, sys
from datetime import datetime, timezone
*files, log = sys.argv[1:]
ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
with open(log, "a") as f:
    for p in files:
        with open(p, "w") as h:
            h.write("<!doctype html><title>Dry extra</title>")
        f.write(json.dumps({"type": "assistant", "timestamp": ts, "cwd": "/x", "sessionId": "dry-run",
                            "message": {"content": [{"type": "tool_use", "name": "Write",
                                                     "input": {"file_path": p}}]}}) + "\n")
PY

OUT3="$ROOT/find3.json"
find_html >"$OUT3"
python3 - "$OUT3" "$SITE/pages/delta.html" "$WT/out/eps.html" <<'PY' || fail "find_html.py after linking a folder"
import json, sys
out, delta, eps = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
by = {x["path"]: x for x in out["candidates"]}
assert len(by) == 5, sorted(by)
assert by[delta]["in_linked_room"] == "site" and by[delta]["linked"] is False, by[delta]
assert by[delta]["in_worktree"] is False, by[delta]
assert by[eps]["in_worktree"] is True and by[eps]["in_linked_room"] is None, by[eps]
assert by[eps]["repo_key"] == "demo-repo" and by[eps]["rel_in_repo"] == "out/eps.html", by[eps]
for p, x in by.items():
    if p not in (delta, eps):
        assert x["linked"] and x["in_linked_room"] is None and x["in_worktree"] is False, x
PY

# The find + realpath duplicate check (from the v7 SKILL.md; still a handy manual check).
dup_check() {
  find "$HOME_DIR" -path "$HOME_DIR/.rooms" -prune -o -type l -exec sh -c '[ "$(realpath "$1")" = "$(realpath "$2")" ] && echo "$1"' _ {} "$1" \;
}
ALPHA_LINKS="$(dup_check "$REPO/out/alpha.html")"
[ "$ALPHA_LINKS" = "$HOME_DIR/demo-repo/alpha.html" ] || fail "dup check for alpha: '$ALPHA_LINKS'"
[ -z "$(dup_check "$WT/out/eps.html")" ] || fail "dup check for eps should be empty"

[ "$(fingerprint)" = "$BEFORE" ] || fail "originals changed"

echo "PASS: find_html -> 3 candidates; rooms demo-repo(2) + inbox(1); Journal days match birthtime; re-run all linked; linked-folder + worktree flags; dup check; originals untouched"
