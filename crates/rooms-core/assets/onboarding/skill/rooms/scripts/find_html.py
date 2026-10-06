#!/usr/bin/env python3
# rooms-onboarding v6
"""List existing .html files that an AI agent wrote recently.

Reads Claude Code, Codex and Aside session logs and <home>/.rooms/state.json
(all read-only), prints JSON to stdout.
Python 3.9+ standard library only. This script never writes anything, except
with --record-sources: then it writes <home>/.rooms/sources.json (which agent
conversation last wrote each file) and nothing else.
"""
import argparse
import html as htmllib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone

CLAUDE_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit", "Artifact"}
PATCH_RE = re.compile(r"\*\*\* (?:Add|Update) File: (\S+\.html?)\b", re.I)
LOOSE_RE = re.compile(r"""[\w@%+=:,./~\-]+\.html?\b""", re.I)
WRITE_HINT_RE = re.compile(
    r"(>|write_text|write_file|writeFile|writeFileSync|\.write\(|open\(|\btee\b|\bcp\b|\bmv\b|sed\s+-i)")
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
TS_RE = re.compile(r"^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)")
TZ_RE = re.compile(r"^(?:\.\d+)?\s*(Z|[+-]\d\d(?::?\d\d)?)?")
ORCA_RE = re.compile(r"/orca/workspaces/([^/]+)/([^/]+)(?:/|$)")

# words may mix quoted parts and escapes; a quote left open runs as a plain character
SHELL_TOKEN_RE = re.compile(r"""[ \t\r]+|(?P<comment>\#[^\n]*)|(?P<op>[();<>|&\n]+)
    |(?P<word>(?:[^\s();<>|&'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*"|['"\\])+)""", re.X)
SHELL_DEQUOTE_RE = re.compile(r"""'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|['"\\]""")
SHELL_UNESCAPE_RE = re.compile(r'\\([\\"$`])')
SHELL_SEPARATORS = set("();|&\n")
SHELL_ASSIGN_RE = re.compile(r"^[A-Za-z_]\w*=")
SHELL_PREFIXES = {"sudo", "env", "command"}
SHELL_MAX_CHARS = 100_000
HEREDOC_RE = re.compile(r"(?<!<)<<-?\s*(['\"]?)(\w+)\1")
COPY_VALUE_FLAGS = {"cp": {"-S"}, "mv": {"-S"}, "install": {"-m", "-o", "-g", "-S"}}

JS_STR = r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`"
JS_NAME = r"[A-Za-z_$][\w$]*"
JS_TERM_RE = re.compile(r"\s*(?:(%s)|(%s))[ \t]*" % (JS_STR, JS_NAME))
JS_EVENT_RE = re.compile(
    r"\b(?:const|let|var)\s+(%s)\s*=|\b(?:writeFile|appendFile)(?:Sync)?\s*\(" % JS_NAME)
JS_DECL_END_RE = re.compile(r"[ \t]*(?:;|\r?\n|$)")
JS_ARG_END_RE = re.compile(r"\s*[,)]")
JS_TEMPLATE_SPLIT_RE = re.compile(r"\$\{\s*(.*?)\s*\}")
JS_ESCAPE_RE = re.compile(r"\\(.)")
ASIDE_DAY_RE = re.compile(r"^\d{4}-\d\d-\d\d$")
WRITE_TOOL_RE = re.compile(r"write|edit", re.I)


def parse_ts(s):
    if not isinstance(s, str):
        return None
    m = TS_RE.match(s)
    if not m:
        return None
    try:
        dt = datetime(*map(int, m.groups()), tzinfo=timezone.utc)
        z = TZ_RE.match(s[m.end():]).group(1)
        if z and z != "Z":
            digits = z[1:].replace(":", "")
            off = timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0))
            dt = dt - off if z[0] == "+" else dt + off
        return dt
    except (ValueError, OverflowError):
        return None


def parse_epoch_ms(v):
    """A datetime from epoch milliseconds (Aside), or an ISO string via parse_ts."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        try:
            return datetime.fromtimestamp(v / 1000, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return parse_ts(v)


def fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_html(p):
    return isinstance(p, str) and p.lower().endswith((".html", ".htm"))


def resolve(path, base):
    """`path` made absolute (with ~ expanded) against `base`; None when it can't be."""
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        if not base:
            return None
        path = os.path.join(base, path)
    return os.path.normpath(path)


# ---- shell commands (Claude Code Bash, Aside bash) ----

def strip_heredocs(command):
    """`command` without here-document bodies (their text is data, not commands)."""
    out, end = [], None
    for line in command.split("\n"):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        m = HEREDOC_RE.search(line)
        if m:
            end = m.group(2)
        out.append(line)
    return "\n".join(out)


def dequote(word):
    def part(m):
        single, double, escaped = m.groups()
        if single is not None:
            return single
        if double is not None:
            return SHELL_UNESCAPE_RE.sub(r"\1", double)
        return escaped or ""
    return SHELL_DEQUOTE_RE.sub(part, word)


def shell_tokens(command):
    """(is_operator, text) tokens. Operators are recognised only outside quotes."""
    text = strip_heredocs(command).replace("\\\n", "")
    for m in SHELL_TOKEN_RE.finditer(text):
        if m.lastgroup == "op":
            yield True, m.group()
        elif m.lastgroup == "word":
            yield False, dequote(m.group())


def shell_segments(tokens):
    """Simple commands as lists of tokens, split on `&&`, `||`, `;`, `|`, `&`, `( )`, newlines."""
    seg = []
    for op, text in tokens:
        if op and set(text) <= SHELL_SEPARATORS:
            if seg:
                yield seg
            seg = []
        else:
            seg.append((op, text))
    if seg:
        yield seg


def split_redirects(seg):
    """(argv, output redirect targets) of one simple command."""
    argv, targets, it = [], [], iter(seg)
    for op, text in it:
        if not op:
            argv.append(text)
            continue
        _, target = next(it, (True, ""))
        if ">" in text:
            targets.append(target)
    return argv, targets


def command_words(argv):
    """`argv` from the command word on: env assignments and sudo/env/command are skipped."""
    i = 0
    while i < len(argv) and (SHELL_ASSIGN_RE.match(argv[i]) or argv[i] in SHELL_PREFIXES):
        i += 1
    return argv[i:]


def copy_dests(prog, args, cwd):
    """Destinations of `cp`/`mv`/`install` args: `-t DIR`, or the last arg (a dir gets basenames)."""
    value_flags = COPY_VALUE_FLAGS[prog]
    target, srcs, flags, it = None, [], True, iter(args)
    for a in it:
        if flags and a == "--":
            flags = False
        elif flags and a == "-t":
            target = next(it, None)
        elif flags and a.startswith("--target-directory="):
            target = a.split("=", 1)[1]
        elif flags and a in value_flags:
            next(it, None)
        elif not (flags and a.startswith("-") and a != "-"):
            srcs.append(a)
    if target is None:
        if len(srcs) < 2:
            return []
        *srcs, target = srcs
        d = shell_path(target, cwd)
        if not (target.endswith("/") or len(srcs) > 1 or (d and os.path.isdir(d))):
            return [target]
    return [os.path.join(target, os.path.basename(s.rstrip("/"))) for s in srcs]


def shell_path(word, cwd):
    """`word` as an absolute path, or None when it is dynamic (`$`, backticks) or unresolvable."""
    if "$" in word or "`" in word:
        return None
    return resolve(word, cwd)


def change_dir(args, cwd):
    if not args:
        return os.path.expanduser("~")
    return None if args[0] == "-" else shell_path(args[0], cwd)


def shell_writes(command, cwd):
    """Absolute .html paths a shell command writes: cp/mv/install, tee and `>`/`>>` targets.

    Relative paths follow `cd` from `cwd`; they are dropped when the directory is unknown.
    """
    if not isinstance(command, str) or len(command) > SHELL_MAX_CHARS:
        return
    for seg in shell_segments(shell_tokens(command)):
        argv, targets = split_redirects(seg)
        words = command_words(argv)
        prog = os.path.basename(words[0]) if words else ""
        if prog == "cd":
            cwd = change_dir(words[1:], cwd)
        elif prog in COPY_VALUE_FLAGS:
            targets += copy_dests(prog, words[1:], cwd)
        elif prog == "tee":
            targets += [a for a in words[1:] if not a.startswith("-")]
        for target in filter(is_html, targets):
            path = shell_path(target, cwd)
            if path:
                yield path


# ---- JavaScript (Aside repl) ----

def js_string(literal, syms):
    """The value of a JS string literal; a template may only use `${NAME}` of known names."""
    body = literal[1:-1]
    if literal[0] != "`":
        return JS_ESCAPE_RE.sub(r"\1", body)
    parts = JS_TEMPLATE_SPLIT_RE.split(body)  # odd items are ${...} expressions
    out = []
    for i, part in enumerate(parts):
        v = syms.get(part) if i % 2 else JS_ESCAPE_RE.sub(r"\1", part)
        if v is None:
            return None
        out.append(v)
    return "".join(out)


def js_expr(code, pos, syms):
    """(value, end) of `term (+ term)*` at `pos`, a term being a string literal or known name.

    The value is None when any term is unknown.
    """
    parts = []
    while True:
        m = JS_TERM_RE.match(code, pos)
        if not m:
            return None, pos
        lit, name = m.groups()
        v = js_string(lit, syms) if lit else syms.get(name)
        if v is None:
            return None, m.end()
        parts.append(v)
        pos = m.end()
        if not code.startswith("+", pos):
            return "".join(parts), pos
        pos += 1


def js_writes(code, syms):
    """Absolute .html paths passed to writeFile/appendFile(Sync) in `code`.

    `syms` holds string consts/lets/vars and is updated in place, so it carries across the
    calls of one session (Aside's repl keeps state between calls).
    """
    if not isinstance(code, str):
        return
    for m in JS_EVENT_RE.finditer(code):
        value, end = js_expr(code, m.end(), syms)
        name = m.group(1)
        if name:
            if value is not None and JS_DECL_END_RE.match(code, end):
                syms[name] = value
            else:
                syms.pop(name, None)  # now something we can't follow
        elif is_html(value) and JS_ARG_END_RE.match(code, end):
            path = resolve(value, None)
            if path:
                yield path


class Collector:
    def __init__(self, cutoff):
        self.cutoff = cutoff
        self.hits = {}  # abs path -> dict
        self.read_errors = 0

    def add(self, path, ts, agent, session, cwd, cwd_base=None, explicit=False):
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
        h["writes"].append((ts, agent, session, cwd, explicit))


def safe_lines(f, col):
    """Yield lines; a mid-read failure is counted and ends that file."""
    it = iter(f)
    while True:
        try:
            yield next(it)
        except StopIteration:
            return
        except (OSError, ValueError):
            col.read_errors += 1
            return


def json_records(path, col, wanted):
    """Decoded JSON lines of `path` for which `wanted(line)`; failures are counted."""
    try:
        f = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        col.read_errors += 1
        return
    with f:
        for line in safe_lines(f, col):
            if not wanted(line):
                continue
            try:
                yield json.loads(line)
            except (ValueError, RecursionError):
                col.read_errors += 1


def mentions_html(line):
    return ".htm" in line or ".HTM" in line


def claude_tool_writes(block, cwd):
    """(path, explicit) for one Claude Code tool_use block. Bash copies are loose."""
    name, inp = block.get("name"), block.get("input") or {}
    if name in CLAUDE_WRITE_TOOLS:
        p = inp.get("file_path") or inp.get("notebook_path")
        if is_html(p):
            yield p, True
    elif name == "Bash":
        for p in shell_writes(inp.get("command"), cwd):
            yield p, False


def scan_claude_file(path, col):
    stem = os.path.splitext(os.path.basename(path))[0]
    for rec in json_records(path, col, mentions_html):
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
                for p, explicit in claude_tool_writes(it, cwd):
                    col.add(p, ts, "claude-code", sid, cwd, explicit=explicit)
        except (AttributeError, TypeError):
            col.read_errors += 1


def aside_call_writes(call, syms):
    """(path, explicit) for one Aside toolCall; `syms` is the session's repl symbol table."""
    name, args = call.get("name") or "", call.get("arguments")
    if not isinstance(args, dict):
        return
    if name == "repl":
        for p in js_writes(args.get("code"), syms):
            yield p, True
    elif name == "bash":
        for p in shell_writes(args.get("command"), None):
            yield p, False
    target = args.get("path") or args.get("file_path")
    if is_html(target) and WRITE_TOOL_RE.search(name):
        path = resolve(target, None)
        if path:
            yield path, True


def scan_aside_file(path, sid, col):
    syms = {}
    for rec in json_records(path, col, lambda line: '"toolCall"' in line):
        try:
            if rec.get("role") != "assistant":
                continue
            ts = parse_epoch_ms(rec.get("timestamp"))
            for call in rec.get("content") or []:
                if not isinstance(call, dict) or call.get("type") != "toolCall":
                    continue
                for p, explicit in aside_call_writes(call, syms):
                    col.add(p, ts, "aside", sid, os.path.dirname(p), explicit=explicit)
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
        for line in safe_lines(f, col):
            has_html = ".htm" in line or ".HTM" in line
            is_meta = '"session_meta"' in line
            is_turn = '"turn_context"' in line and '"cwd"' in line
            if not (has_html or is_meta or is_turn):
                continue
            try:
                rec = json.loads(line)
            except (ValueError, RecursionError):
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
                        col.add(p, ts, "codex", sid, cwd, explicit=True)
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


def codex_files(root, cutoff_dt, cutoff_epoch, col):
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
                    try:
                        names = sorted(os.listdir(dd))
                    except OSError:
                        col.read_errors += 1
                        continue
                    for n in names:
                        if n.endswith(".jsonl"):
                            yield os.path.join(dd, n)
    arch = os.path.join(os.path.dirname(os.path.normpath(root)), "archived_sessions")
    if os.path.isdir(arch):
        try:
            arch_names = sorted(os.listdir(arch))
        except OSError:
            col.read_errors += 1
            arch_names = []
        for n in arch_names:
            p = os.path.join(arch, n)
            if n.startswith("rollout-") and n.endswith(".jsonl"):
                try:
                    if os.stat(p).st_mtime >= cutoff_epoch:
                        yield p
                except OSError:
                    pass


def aside_files(root, cutoff_dt):
    """(messages.jsonl, session id) under <root>/<account>/sessions/<YYYY-MM-DD>_<id>/."""
    floor = (cutoff_dt - timedelta(days=1)).date().isoformat()
    for account in sorted(_dirs(root)):
        sessions = os.path.join(root, account, "sessions")
        for name in sorted(_dirs(sessions)):
            day, _, sid = name.partition("_")
            if not sid or not ASIDE_DAY_RE.match(day) or day < floor:
                continue
            p = os.path.join(sessions, name, "messages.jsonl")
            if os.path.isfile(p):
                yield p, sid


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
        # Aside's own state (session scratch, tmp); only its artifacts are documents
        if under(p, os.path.join(home_dir, ".aside")) and "artifacts" not in segs:
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
    """(repo_key, repo_root, in_worktree). in_worktree: the nearest `.git` above is a file."""
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
            return repo or os.path.basename(os.path.dirname(d)) or os.path.basename(d), d, True
        if os.path.isdir(g):
            return os.path.basename(d), d, False
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    m = ORCA_RE.search(real)
    if m:
        return m.group(1), real[:m.start(2)] + m.group(2), False
    pd = os.path.dirname(real)
    return os.path.basename(pd) or "/", pd, False


def linked_rooms(home):
    """[(realpath, name)] of the linked-folder rooms in <home>/.rooms/state.json (read-only).

    A missing, unreadable or malformed file means no linked rooms.
    """
    try:
        with open(os.path.join(home, ".rooms", "state.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, RecursionError):
        return []
    rooms = data.get("rooms") if isinstance(data, dict) else None
    out = []
    for r in rooms if isinstance(rooms, list) else []:
        if not isinstance(r, dict) or r.get("kind") != "linked":
            continue
        path, name = r.get("path"), r.get("name")
        if not isinstance(path, str) or not path or not isinstance(name, str):
            continue
        out.append((os.path.realpath(os.path.expanduser(path)), name))
    # deepest first, so a nested linked room wins over its parent
    out.sort(key=lambda x: len(x[0]), reverse=True)
    return out


def in_linked_room(real, rooms):
    for root, name in rooms:
        if under(real, root):
            return name
    return None


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
        if dp == home:
            dn[:] = [d for d in dn if d != ".rooms"]
        for n in dn + fn:
            p = os.path.join(dp, n)
            if os.path.islink(p):
                r = os.path.realpath(p)
                if r in wanted:
                    out.setdefault(r, []).append(p)
    for v in out.values():
        v.sort()
    return out


def source_entry(path, writes):
    """The sources.json entry for one file, or None when it has no session.

    `writes` is sorted by time. The last explicit write wins over loose shell
    matches (Codex mentions, Bash copies), which may only mention or copy the path.
    """
    explicit = [w for w in writes if w[4]]
    ts, agent, session, cwd, _ = (explicit or writes)[-1]
    if not session:
        return None
    return {"agent": agent, "session": session,
            "cwd": cwd or os.path.dirname(path), "writtenAt": fmt(ts)}


def read_sources(target):
    """The "sources" map of an existing sources.json; empty when missing or invalid."""
    try:
        with open(target, encoding="utf-8") as f:
            old = json.load(f).get("sources")
    except (OSError, ValueError, AttributeError):
        return {}
    return {k: v for k, v in old.items() if isinstance(v, dict)} if isinstance(old, dict) else {}


def write_sources(target, sources):
    """Atomically replace `target` via a private temp file (safe for concurrent runs)."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".sources.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "sources": sources}, f, ensure_ascii=False,
                      indent=1, sort_keys=True)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def record_sources(rooms_home, cands, writes_by_path):
    """Merge each candidate's source into <rooms_home>/.rooms/sources.json.

    Never raises: returns the output fields {"recorded": n} on success, or adds
    "record_error" when nothing could be written. An existing entry with a newer
    writtenAt is kept; a corrupt or unreadable file starts from empty. Nothing is
    created when <rooms_home>/.rooms is missing (roomsd always creates it).
    """
    d = os.path.join(rooms_home, ".rooms")
    if not os.path.isdir(d):
        return {"recorded": 0, "record_error": "no .rooms in " + rooms_home}
    target = os.path.join(d, "sources.json")
    merged = read_sources(target)
    n = 0
    for c in cands:
        entry = source_entry(c["path"], writes_by_path[c["path"]])
        stored = merged.get(c["path"], {}).get("writtenAt")
        if entry is None or (isinstance(stored, str) and stored > entry["writtenAt"]):
            continue
        merged[c["path"]] = entry
        n += 1
    try:
        write_sources(target, merged)
    except OSError as e:
        return {"recorded": None, "record_error": str(e)}
    return {"recorded": n}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--home", default="~/rooms")
    ap.add_argument("--claude-dir", default="~/.claude/projects")
    ap.add_argument("--codex-dir", default="~/.codex/sessions")
    ap.add_argument("--aside-dir", default="~/.aside/u")
    ap.add_argument("--include-noise", action="store_true")
    ap.add_argument("--record-sources", action="store_true",
                    help="write <home>/.rooms/sources.json: which conversation wrote each file")
    a = ap.parse_args(argv)

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=a.days)
    cutoff_epoch = cutoff.timestamp()
    user_home = os.path.realpath(os.path.expanduser("~"))
    rooms_home = os.path.realpath(os.path.expanduser(a.home))

    col = Collector(cutoff)
    for p in claude_files(os.path.expanduser(a.claude_dir), cutoff_epoch):
        scan_claude_file(p, col)
    for p in codex_files(os.path.expanduser(a.codex_dir), cutoff, cutoff_epoch, col):
        scan_codex_file(p, col)
    for p, sid in aside_files(os.path.expanduser(a.aside_dir), cutoff):
        scan_aside_file(p, sid, col)

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
            # shell matches are loose guesses; only explicit writes count
            if any(w[4] for w in h["writes"]):
                missing += 1
            continue
        m = merged.setdefault(real, [])
        m.extend(h["writes"])

    links = find_links(rooms_home, set(merged))
    linked_roots = linked_rooms(rooms_home)
    cands = []
    for real, writes in sorted(merged.items()):
        writes.sort(key=lambda w: w[0])
        first, last = writes[0], writes[-1]
        key, root, worktree = repo_info(real)
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
            "in_linked_room": in_linked_room(real, linked_roots),
            "in_worktree": worktree,
        })
    cands.sort(key=lambda c: c["last_written"], reverse=True)
    out = {
        "version": 2, "days": a.days, "generated_at": fmt(now), "candidates": cands,
        "skipped": {"noise": noise, "missing": missing, "read_errors": col.read_errors},
    }
    if a.record_sources:
        out.update(record_sources(rooms_home, cands, merged))
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
