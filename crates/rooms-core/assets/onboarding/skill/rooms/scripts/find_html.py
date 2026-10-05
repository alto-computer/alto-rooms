#!/usr/bin/env python3
# rooms-onboarding v1
"""List existing .html files that an AI agent wrote recently.

Reads Claude Code and Codex session logs (read-only), prints JSON to stdout.
Python 3.9+ standard library only. This script never writes anything.
"""
import argparse
import html as htmllib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

CLAUDE_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit", "Artifact"}
PATCH_RE = re.compile(r"\*\*\* (?:Add|Update) File: (\S+\.html?)\b", re.I)
LOOSE_RE = re.compile(r"""[\w@%+=:,./~\-]+\.html?\b""", re.I)
WRITE_HINT_RE = re.compile(
    r"(>|write_text|write_file|writeFile|writeFileSync|\.write\(|open\(|\btee\b|\bcp\b|\bmv\b|sed\s+-i)")
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
TS_RE = re.compile(r"^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)")
ORCA_RE = re.compile(r"/orca/workspaces/([^/]+)/([^/]+)(?:/|$)")


def parse_ts(s):
    if not isinstance(s, str):
        return None
    m = TS_RE.match(s)
    if not m:
        return None
    try:
        return datetime(*map(int, m.groups()), tzinfo=timezone.utc)
    except ValueError:
        return None


def fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_html(p):
    return isinstance(p, str) and p.lower().endswith((".html", ".htm"))


class Collector:
    def __init__(self, cutoff):
        self.cutoff = cutoff
        self.hits = {}  # abs path -> dict
        self.read_errors = 0

    def add(self, path, ts, agent, session, cwd, cwd_base=None):
        if not path or ts is None or ts < self.cutoff:
            return
        if path.startswith("~"):
            path = os.path.expanduser(path)
        if not os.path.isabs(path):
            base = cwd_base or cwd
            if not base:
                return
            path = os.path.join(base, path)
        path = os.path.normpath(path)
        h = self.hits.setdefault(path, {"writes": []})
        h["writes"].append((ts, agent, session, cwd))


def scan_claude_file(path, col):
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        f = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        col.read_errors += 1
        return
    with f:
        for line in f:
            if ".htm" not in line and ".HTM" not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                col.read_errors += 1
                continue
            try:
                if rec.get("type") != "assistant":
                    continue
                ts = parse_ts(rec.get("timestamp"))
                cwd = rec.get("cwd")
                sid = rec.get("sessionId") or stem
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for it in content:
                    if not isinstance(it, dict) or it.get("type") != "tool_use":
                        continue
                    if it.get("name") not in CLAUDE_WRITE_TOOLS:
                        continue
                    inp = it.get("input") or {}
                    p = inp.get("file_path") or inp.get("notebook_path")
                    if is_html(p):
                        col.add(p, ts, "claude-code", sid, cwd)
            except (AttributeError, TypeError):
                col.read_errors += 1


def codex_texts(payload):
    """Yield the command text of a Codex write-capable record."""
    t = payload.get("type")
    if t == "custom_tool_call" and payload.get("name") == "exec":
        v = payload.get("input")
    elif t == "function_call":
        v = payload.get("arguments")
        if v is None:
            v = payload.get("input")
    else:
        return None
    if isinstance(v, (dict, list)):
        v = json.dumps(v)
    return v if isinstance(v, str) else None


def scan_codex_file(path, col):
    stem = os.path.splitext(os.path.basename(path))[0]
    sid = stem
    cwd = None
    try:
        f = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        col.read_errors += 1
        return
    with f:
        for line in f:
            has_html = ".htm" in line or ".HTM" in line
            is_meta = '"session_meta"' in line
            is_turn = '"turn_context"' in line and '"cwd"' in line
            if not (has_html or is_meta or is_turn):
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                col.read_errors += 1
                continue
            try:
                payload = rec.get("payload") or {}
                rtype = rec.get("type")
                if rtype == "session_meta":
                    if payload.get("cwd"):
                        cwd = payload["cwd"]
                    if payload.get("id"):
                        sid = payload["id"]
                    continue
                if rtype == "turn_context":
                    if payload.get("cwd"):
                        cwd = payload["cwd"]
                    continue
                if rtype != "response_item" or not has_html:
                    continue
                text = codex_texts(payload)
                if not text:
                    continue
                ts = parse_ts(rec.get("timestamp"))
                text = text.replace("\\\\n", "\n").replace("\\n", "\n")
                found = PATCH_RE.findall(text)
                if found:
                    for p in found:
                        col.add(p, ts, "codex", sid, cwd)
                    continue
                if not WRITE_HINT_RE.search(text):
                    continue
                for p in LOOSE_RE.findall(text):
                    if p.startswith("-") or p.startswith("http"):
                        continue
                    col.add(p, ts, "codex", sid, cwd)
            except (AttributeError, TypeError):
                col.read_errors += 1


def claude_files(root, cutoff_epoch):
    if not os.path.isdir(root):
        return
    for dp, _dn, fn in os.walk(root):
        for n in sorted(fn):
            if not n.endswith(".jsonl"):
                continue
            p = os.path.join(dp, n)
            try:
                if os.stat(p).st_mtime < cutoff_epoch:
                    continue
            except OSError:
                continue
            yield p


def codex_files(root, cutoff_dt, cutoff_epoch):
    floor = (cutoff_dt - timedelta(days=1)).date()
    if os.path.isdir(root):
        for y in sorted(_dirs(root)):
            if not y.isdigit():
                continue
            if int(y) < floor.year:
                continue
            for m in sorted(_dirs(os.path.join(root, y))):
                if not m.isdigit() or not 1 <= int(m) <= 12:
                    continue
                if (int(y), int(m)) < (floor.year, floor.month):
                    continue
                for d in sorted(_dirs(os.path.join(root, y, m))):
                    if not d.isdigit():
                        continue
                    try:
                        if datetime(int(y), int(m), int(d)).date() < floor:
                            continue
                    except ValueError:
                        continue
                    dd = os.path.join(root, y, m, d)
                    for n in sorted(os.listdir(dd)):
                        if n.endswith(".jsonl"):
                            yield os.path.join(dd, n)
    arch = os.path.join(os.path.dirname(os.path.normpath(root)), "archived_sessions")
    if os.path.isdir(arch):
        for n in sorted(os.listdir(arch)):
            p = os.path.join(arch, n)
            if n.startswith("rollout-") and n.endswith(".jsonl"):
                try:
                    if os.stat(p).st_mtime >= cutoff_epoch:
                        yield p
                except OSError:
                    pass


def _dirs(p):
    try:
        return [e.name for e in os.scandir(p) if e.is_dir()]
    except OSError:
        return []


def under(path, prefix):
    return path == prefix or path.startswith(prefix.rstrip("/") + "/")


def is_noise(raw, real, home_dir, rooms_home):
    for p in (raw, real):
        segs = p.split("/")
        if "scratchpad" in segs or "node_modules" in segs:
            return True
        if ".superpowers/brainstorm" in p:
            return True
        if under(p, os.path.join(home_dir, ".claude")) or under(p, os.path.join(home_dir, ".codex")):
            return True
        if under(p, rooms_home):
            return True
        codex_docs = os.path.join(home_dir, "Documents", "Codex")
        if under(p, codex_docs):
            rest = p[len(codex_docs):].strip("/").split("/")
            if len(rest) >= 2 and rest[1] == "work":
                return True
        if not under(p, home_dir):
            for t in ("/tmp", "/private/tmp", "/var/folders", "/private/var/folders"):
                if under(p, t):
                    return True
    return False


def repo_info(real):
    d = os.path.dirname(real)
    while True:
        g = os.path.join(d, ".git")
        if os.path.isfile(g):
            repo = None
            try:
                with open(g, "r", errors="replace") as f:
                    first = f.readline().strip()
                if first.startswith("gitdir:") and "/.git/worktrees/" in first:
                    repo = os.path.basename(first[7:].strip().split("/.git/worktrees/")[0])
            except OSError:
                pass
            return repo or os.path.basename(os.path.dirname(d)) or os.path.basename(d), d
        if os.path.isdir(g):
            return os.path.basename(d), d
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    m = ORCA_RE.search(real)
    if m:
        return m.group(1), real[:m.start(2)] + m.group(2)
    pd = os.path.dirname(real)
    return os.path.basename(pd) or "/", pd


def read_title(path):
    base = os.path.basename(path)
    try:
        with open(path, "rb") as f:
            head = f.read(64 * 1024).decode("utf-8", errors="replace")
    except OSError:
        return base
    m = TITLE_RE.search(head)
    if m:
        t = " ".join(htmllib.unescape(m.group(1)).split())
        if t:
            return t
    return base


def find_links(home, wanted):
    """Map realpath -> [symlink paths] for symlinks under home (dirs not followed)."""
    out = {}
    if not os.path.isdir(home):
        return out
    for dp, dn, fn in os.walk(home, followlinks=False):
        for n in dn + fn:
            p = os.path.join(dp, n)
            if os.path.islink(p):
                r = os.path.realpath(p)
                if r in wanted:
                    out.setdefault(r, []).append(p)
    for v in out.values():
        v.sort()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--home", default="~/rooms")
    ap.add_argument("--claude-dir", default="~/.claude/projects")
    ap.add_argument("--codex-dir", default="~/.codex/sessions")
    ap.add_argument("--include-noise", action="store_true")
    a = ap.parse_args(argv)

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=a.days)
    cutoff_epoch = cutoff.timestamp()
    user_home = os.path.realpath(os.path.expanduser("~"))
    rooms_home = os.path.realpath(os.path.expanduser(a.home))

    col = Collector(cutoff)
    for p in claude_files(os.path.expanduser(a.claude_dir), cutoff_epoch):
        scan_claude_file(p, col)
    for p in codex_files(os.path.expanduser(a.codex_dir), cutoff, cutoff_epoch):
        scan_codex_file(p, col)

    noise = missing = 0
    merged = {}
    for raw, h in sorted(col.hits.items()):
        if os.path.isfile(raw):
            real = os.path.realpath(raw)
        else:
            real = None
        if not a.include_noise and is_noise(raw, real or os.path.realpath(raw), user_home, rooms_home):
            noise += 1
            continue
        if real is None:
            # Codex shell matches are loose guesses; only Claude Code misses are counted
            if any(w[1] == "claude-code" for w in h["writes"]):
                missing += 1
            continue
        m = merged.setdefault(real, [])
        m.extend(h["writes"])

    links = find_links(rooms_home, set(merged))
    cands = []
    for real, writes in sorted(merged.items()):
        writes.sort(key=lambda w: w[0])
        first, last = writes[0], writes[-1]
        key, root = repo_info(real)
        sessions = []
        for w in writes:
            if w[2] and w[2] not in sessions:
                sessions.append(w[2])
        cands.append({
            "path": real,
            "title": read_title(real),
            "agent": last[1],
            "first_written": fmt(first[0]),
            "last_written": fmt(last[0]),
            "sessions": sessions,
            "cwd": last[3] or os.path.dirname(real),
            "repo_key": key,
            "rel_in_repo": os.path.relpath(real, root),
            "linked": real in links,
            "linked_at": links.get(real, []),
        })
    cands.sort(key=lambda c: c["last_written"], reverse=True)
    json.dump({
        "version": 1, "days": a.days, "generated_at": fmt(now), "candidates": cands,
        "skipped": {"noise": noise, "missing": missing, "read_errors": col.read_errors},
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
