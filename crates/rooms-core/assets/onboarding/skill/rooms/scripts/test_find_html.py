import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "find_html.py")


def iso(days_ago=0.0):
    t = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.123Z")


class Env:
    """A synthetic HOME with fake Claude Code and Codex log dirs."""

    def __init__(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="findhtml-"))
        self.home = os.path.join(self.root, "rooms")
        self.claude = os.path.join(self.root, ".claude", "projects")
        self.codex = os.path.join(self.root, ".codex", "sessions")
        os.makedirs(self.home)
        os.makedirs(os.path.join(self.claude, "-proj"))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def html(self, rel, body="<html><head><title>T %s</title></head></html>"):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(body % rel if "%s" in body else body)
        return p

    def claude_log(self, lines, name="s1.jsonl"):
        p = os.path.join(self.claude, "-proj", name)
        with open(p, "w") as f:
            for l in lines:
                f.write((l if isinstance(l, str) else json.dumps(l)) + "\n")
        return p

    def codex_log(self, lines, days_ago=0, name="rollout-2026-01-01T00-00-00-abc.jsonl"):
        d = datetime.now(timezone.utc) - timedelta(days=days_ago)
        dd = os.path.join(self.codex, d.strftime("%Y"), d.strftime("%m"), d.strftime("%d"))
        os.makedirs(dd, exist_ok=True)
        p = os.path.join(dd, name)
        with open(p, "w") as f:
            for l in lines:
                f.write((l if isinstance(l, str) else json.dumps(l)) + "\n")
        return p

    def run(self, *extra):
        env = dict(os.environ, HOME=self.root)
        r = subprocess.run(
            [sys.executable, SCRIPT, "--home", self.home, "--claude-dir", self.claude,
             "--codex-dir", self.codex, *extra],
            capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)


def cc(name, path, days_ago=1, cwd="/x", sid="sess-cc", block_type="tool_use"):
    return {"type": "assistant", "timestamp": iso(days_ago), "cwd": cwd, "sessionId": sid,
            "message": {"content": [{"type": block_type, "name": name,
                                     "input": {"file_path": path}}]}}


def cx_meta(cwd, sid="sess-cx", days_ago=1):
    return {"timestamp": iso(days_ago), "type": "session_meta", "payload": {"id": sid, "cwd": cwd}}


def cx_exec(text, days_ago=1):
    return {"timestamp": iso(days_ago), "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "exec", "input": text}}


class FindHtmlTest(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.addCleanup(self.e.cleanup)

    def paths(self, out):
        return sorted(c["path"] for c in out["candidates"])

    def test_claude_write_edit_artifact_counted_read_not(self):
        w = self.e.html("proj/w.html")
        ed = self.e.html("proj/e.html")
        ar = self.e.html("proj/a.html")
        rd = self.e.html("proj/r.html")
        self.e.claude_log([cc("Write", w), cc("Edit", ed), cc("Artifact", ar), cc("Read", rd)])
        out = self.e.run()
        self.assertEqual(self.paths(out), sorted([w, ed, ar]))
        c = [c for c in out["candidates"] if c["path"] == w][0]
        self.assertEqual(c["agent"], "claude-code")
        self.assertEqual(c["sessions"], ["sess-cc"])
        self.assertEqual(c["title"], "T proj/w.html")
        self.assertFalse(c["linked"])
        self.assertEqual(c["linked_at"], [])

    def test_title_falls_back_to_basename(self):
        p = self.e.html("proj/notitle.html", body="<html></html>")
        self.e.claude_log([cc("Write", p)])
        self.assertEqual(self.e.run()["candidates"][0]["title"], "notitle.html")

    def test_codex_apply_patch_absolute_and_shell_relative(self):
        a = self.e.html("proj/patched.html")
        s = self.e.html("proj/outputs/shell.html")
        r = self.e.html("proj/readonly.html")
        patch = 'tools.apply_patch("*** Begin Patch\\n*** Add File: %s\\n+<html>\\n*** End Patch")' % a
        shell = 'tools.exec_command({cmd:"echo hi > outputs/shell.html"})'
        read = 'tools.exec_command({cmd:"cat readonly.html"})'
        self.e.codex_log([cx_meta(os.path.join(self.e.root, "proj")),
                          cx_exec(patch), cx_exec(shell), cx_exec(read)])
        out = self.e.run()
        self.assertEqual(self.paths(out), sorted([a, s]))
        c = [c for c in out["candidates"] if c["path"] == a][0]
        self.assertEqual(c["agent"], "codex")
        self.assertEqual(c["sessions"], ["sess-cx"])
        self.assertEqual(c["cwd"], os.path.join(self.e.root, "proj"))

    def test_codex_real_newline_patch_and_function_call(self):
        a = self.e.html("proj/p2.html")
        b = self.e.html("proj/f.html")
        patch = "tools.apply_patch(\"*** Begin Patch\n*** Update File: %s\n@@\")" % a
        fc = {"timestamp": iso(1), "type": "response_item",
              "payload": {"type": "function_call", "name": "shell",
                          "arguments": json.dumps({"command": ["bash", "-lc", "echo > f.html"]})}}
        self.e.codex_log([cx_meta(os.path.join(self.e.root, "proj")), cx_exec(patch), fc])
        self.assertEqual(self.paths(self.e.run()), sorted([a, b]))

    def test_old_records_excluded(self):
        old = self.e.html("proj/old.html")
        new = self.e.html("proj/new.html")
        self.e.claude_log([cc("Write", old, days_ago=20), cc("Write", new, days_ago=2)])
        self.assertEqual(self.paths(self.e.run()), [new])
        self.assertEqual(self.paths(self.e.run("--days", "30")), sorted([old, new]))

    def test_old_codex_dir_and_old_mtime_pruned(self):
        old = self.e.html("proj/oldx.html")
        self.e.codex_log([cx_meta("/x", days_ago=40), cx_exec(
            'tools.apply_patch("*** Add File: %s\\n")' % old, days_ago=1)], days_ago=40)
        p = self.e.claude_log([cc("Write", old)])
        past = (datetime.now() - timedelta(days=60)).timestamp()
        os.utime(p, (past, past))
        self.assertEqual(self.paths(self.e.run()), [])

    def test_codex_archived_sessions(self):
        a = self.e.html("proj/arch.html")
        d = os.path.join(self.e.root, ".codex", "archived_sessions")
        os.makedirs(d)
        with open(os.path.join(d, "rollout-x.jsonl"), "w") as f:
            f.write(json.dumps(cx_exec('tools.apply_patch("*** Add File: %s\\n")' % a)) + "\n")
        self.assertEqual(self.paths(self.e.run()), [a])

    def test_missing_counted(self):
        self.e.claude_log([cc("Write", os.path.join(self.e.root, "proj/gone.html"))])
        out = self.e.run()
        self.assertEqual(out["candidates"], [])
        self.assertEqual(out["skipped"]["missing"], 1)

    def test_noise_skipped_unless_included(self):
        n1 = self.e.html(".claude/x/n.html")
        n2 = self.e.html("proj/node_modules/pkg/n.html")
        n3 = self.e.html("proj/scratchpad/n.html")
        n4 = self.e.html(".superpowers/brainstorm/n.html")
        n5 = self.e.html("rooms/inbox/n.html")
        ok = self.e.html("proj/ok.html")
        self.e.claude_log([cc("Write", p) for p in (n1, n2, n3, n4, n5, ok)])
        out = self.e.run()
        self.assertEqual(self.paths(out), [ok])
        self.assertEqual(out["skipped"]["noise"], 5)
        out = self.e.run("--include-noise")
        self.assertEqual(len(out["candidates"]), 6)

    def test_worktree_copies_share_repo_key(self):
        a = self.e.html("orca/workspaces/myrepo/feat-a/docs/x.html")
        b = self.e.html("orca/workspaces/myrepo/feat-b/docs/x.html")
        self.e.claude_log([cc("Write", a), cc("Write", b)])
        cs = self.e.run()["candidates"]
        self.assertEqual({c["repo_key"] for c in cs}, {"myrepo"})
        self.assertEqual({c["rel_in_repo"] for c in cs}, {"docs/x.html"})

    def test_worktree_via_dotgit_file(self):
        wt = os.path.join(self.e.root, "wt", "branch1")
        os.makedirs(wt)
        with open(os.path.join(wt, ".git"), "w") as f:
            f.write("gitdir: /somewhere/realrepo/.git/worktrees/branch1\n")
        a = self.e.html("wt/branch1/sub/y.html")
        self.e.claude_log([cc("Write", a)])
        c = self.e.run()["candidates"][0]
        self.assertEqual(c["repo_key"], "realrepo")
        self.assertEqual(c["rel_in_repo"], "sub/y.html")

    def test_linked_original(self):
        a = self.e.html("proj/linked.html")
        room = os.path.join(self.e.home, "work")
        os.makedirs(room)
        os.symlink(a, os.path.join(room, "alias.html"))
        self.e.claude_log([cc("Write", a)])
        c = self.e.run()["candidates"][0]
        self.assertTrue(c["linked"])
        self.assertEqual(c["linked_at"], [os.path.join(room, "alias.html")])

    def test_truncated_and_garbage_lines_tolerated(self):
        a = self.e.html("proj/good.html")
        self.e.claude_log(['{"type":"assistant","message":{"content":[{"name":"Write","input":{"file_path":"/a.html',
                           "not json .html",
                           {"type": "assistant", "message": None, "x": ".html"},
                           cc("Write", a)])
        out = self.e.run()
        self.assertEqual(self.paths(out), [a])
        self.assertGreaterEqual(out["skipped"]["read_errors"], 2)

    def test_no_logs_exit_zero(self):
        shutil.rmtree(os.path.join(self.e.root, ".claude"))
        out = self.e.run()
        self.assertEqual(out["candidates"], [])

    def test_dedupe_and_range(self):
        a = self.e.html("proj/d.html")
        self.e.claude_log([cc("Write", a, days_ago=5, sid="s1"), cc("Edit", a, days_ago=1, sid="s2")])
        cs = self.e.run()["candidates"]
        self.assertEqual(len(cs), 1)
        self.assertEqual(sorted(cs[0]["sessions"]), ["s1", "s2"])
        self.assertLess(cs[0]["first_written"], cs[0]["last_written"])

    # ---- fix round 1 ----
    def test_non_utf8_bytes_tolerated(self):
        a = self.e.html("proj/u.html")
        p = self.e.claude_log([cc("Write", a)])
        with open(p, "ab") as f:
            f.write(b'\xff\xfe broken .html bytes\n')
        self.assertEqual(self.paths(self.e.run()), [a])

    def test_unreadable_codex_day_dir(self):
        a = self.e.html("proj/ok2.html")
        p = self.e.codex_log([cx_meta("/x")])
        day = os.path.dirname(p)
        self.e.claude_log([cc("Write", a)])
        os.chmod(day, 0)
        self.addCleanup(os.chmod, day, 0o755)
        out = self.e.run()
        self.assertEqual(self.paths(out), [a])
        self.assertGreaterEqual(out["skipped"]["read_errors"], 1)

    def test_broken_symlink_in_home(self):
        a = self.e.html("proj/bs.html")
        os.symlink(os.path.join(self.e.root, "nope.html"), os.path.join(self.e.home, "dead.html"))
        self.e.claude_log([cc("Write", a)])
        c = self.e.run()["candidates"][0]
        self.assertFalse(c["linked"])

    def test_dot_rooms_pruned_in_link_scan(self):
        a = self.e.html("proj/dr.html")
        d = os.path.join(self.e.home, ".rooms", "x")
        os.makedirs(d)
        os.symlink(a, os.path.join(d, "l.html"))
        self.e.claude_log([cc("Write", a)])
        self.assertFalse(self.e.run()["candidates"][0]["linked"])

    def test_malformed_gitdir(self):
        wt = os.path.join(self.e.root, "wt2", "br")
        os.makedirs(wt)
        with open(os.path.join(wt, ".git"), "wb") as f:
            f.write(b"gitdir: \xff\xfe /.git/worktrees/\n")
        a = self.e.html("wt2/br/z.html")
        self.e.claude_log([cc("Write", a)])
        c = self.e.run()["candidates"][0]
        self.assertEqual(c["rel_in_repo"], "z.html")

    def test_codex_cwd_isolated_between_files(self):
        self.e.html("proj/rel.html")
        self.e.codex_log([cx_meta(os.path.join(self.e.root, "proj"), sid="one")], name="rollout-a.jsonl")
        self.e.codex_log([cx_exec('tools.exec_command({cmd:"echo > rel.html"})')], name="rollout-b.jsonl")
        self.assertEqual(self.e.run()["candidates"], [])

    def test_title_after_64kb_not_found(self):
        body = "<html><head>" + "x" * 70000 + "<title>Late</title></head></html>"
        p = self.e.html("proj/late.html", body=body)
        self.e.claude_log([cc("Write", p)])
        self.assertEqual(self.e.run()["candidates"][0]["title"], "late.html")

    def test_offset_timestamps(self):
        out_w = self.e.html("proj/out.html")
        in_w = self.e.html("proj/in.html")
        now = datetime.now(timezone.utc)
        t_out = (now - timedelta(days=14.2) + timedelta(hours=9)).strftime("%Y-%m-%dT%H:%M:%S+09:00")
        t_in = (now - timedelta(days=13.9) - timedelta(hours=9)).strftime("%Y-%m-%dT%H:%M:%S-09:00")
        r1 = cc("Write", out_w); r1["timestamp"] = t_out
        r2 = cc("Write", in_w); r2["timestamp"] = t_in
        self.e.claude_log([r1, r2])
        self.assertEqual(self.paths(self.e.run()), [in_w])

    def test_codex_missing_patch_counted_loose_not(self):
        self.e.codex_log([cx_meta(self.e.root),
                          cx_exec('tools.apply_patch("*** Add File: %s/gone.html\\n")' % self.e.root),
                          cx_exec('tools.exec_command({cmd:"echo > ghost.html"})')])
        out = self.e.run()
        self.assertEqual(out["skipped"]["missing"], 1)

    # ---- final fix wave: linked-folder rooms and worktrees ----
    def write_state(self, body):
        d = os.path.join(self.e.home, ".rooms")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "state.json"), "w") as f:
            f.write(body if isinstance(body, str) else json.dumps(body))

    def test_in_linked_room(self):
        inside = self.e.html("docs/site/deep/a.html")
        outside = self.e.html("docs/other/b.html")
        sibling = self.e.html("docs/site-2/c.html")
        # the room's path is given through a symlink: realpaths are compared
        os.symlink(os.path.join(self.e.root, "docs", "site"), os.path.join(self.e.root, "alias"))
        self.write_state({"rooms": [
            {"id": "r1", "name": "사이트", "kind": "linked", "path": os.path.join(self.e.root, "alias"),
             "dev": None, "ino": None},
            {"id": "r2", "name": "owned", "kind": "owned", "path": os.path.join(self.e.root, "docs", "other"),
             "dev": None, "ino": None},
        ]})
        self.e.claude_log([cc("Write", p) for p in (inside, outside, sibling)])
        by = {c["path"]: c for c in self.e.run()["candidates"]}
        self.assertEqual(by[inside]["in_linked_room"], "사이트")
        self.assertIsNone(by[outside]["in_linked_room"])
        self.assertIsNone(by[sibling]["in_linked_room"])

    def test_state_json_missing_or_malformed_means_no_linked_rooms(self):
        a = self.e.html("docs/site/a.html")
        self.e.claude_log([cc("Write", a)])
        self.assertIsNone(self.e.run()["candidates"][0]["in_linked_room"])  # missing
        for body in ("{not json", "[]", '{"rooms": 3}', '{"rooms": [1, {"kind": "linked"}, '
                     '{"kind": "linked", "path": 5, "name": "x"}]}'):
            self.write_state(body)
            self.assertIsNone(self.e.run()["candidates"][0]["in_linked_room"], body)

    def test_state_json_is_not_written(self):
        a = self.e.html("docs/site/a.html")
        self.e.claude_log([cc("Write", a)])
        body = json.dumps({"rooms": [{"id": "r", "name": "n", "kind": "linked",
                                      "path": os.path.join(self.e.root, "docs", "site")}]})
        self.write_state(body)
        p = os.path.join(self.e.home, ".rooms", "state.json")
        before = os.stat(p).st_mtime_ns
        self.assertEqual(self.e.run()["candidates"][0]["in_linked_room"], "n")
        with open(p) as f:
            self.assertEqual(f.read(), body)
        self.assertEqual(os.stat(p).st_mtime_ns, before)

    def test_in_worktree(self):
        wt = os.path.join(self.e.root, "wt3", "br")
        os.makedirs(wt)
        with open(os.path.join(wt, ".git"), "w") as f:
            f.write("gitdir: /r/main/.git/worktrees/br\n")
        main = os.path.join(self.e.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        w = self.e.html("wt3/br/sub/w.html")
        m = self.e.html("main/sub/m.html")
        plain = self.e.html("plain/p.html")
        self.e.claude_log([cc("Write", p) for p in (w, m, plain)])
        by = {c["path"]: c for c in self.e.run()["candidates"]}
        self.assertTrue(by[w]["in_worktree"])
        self.assertFalse(by[m]["in_worktree"])
        self.assertFalse(by[plain]["in_worktree"])

    def test_output_version_2(self):
        a = self.e.html("proj/v.html")
        self.e.claude_log([cc("Write", a)])
        self.assertEqual(self.e.run()["version"], 2)

    # ---- --record-sources ----

    def dot_rooms(self):
        d = os.path.join(self.e.home, ".rooms")
        os.makedirs(d, exist_ok=True)
        return d

    def sources(self):
        with open(os.path.join(self.e.home, ".rooms", "sources.json")) as f:
            return json.load(f)

    def test_record_sources_writes_entry(self):
        self.dot_rooms()
        a = self.e.html("proj/rs.html")
        self.e.claude_log([cc("Write", a, cwd="/work", sid="sid-1")])
        out = self.e.run("--record-sources")
        self.assertEqual(out["recorded"], 1)
        c = out["candidates"][0]
        self.assertEqual(self.sources(), {"version": 1, "sources": {a: {
            "agent": "claude-code", "session": "sid-1", "cwd": "/work",
            "writtenAt": c["last_written"]}}})

    def test_record_sources_includes_linked(self):
        self.dot_rooms()
        a = self.e.html("proj/rl.html")
        room = os.path.join(self.e.home, "room")
        os.makedirs(room)
        os.symlink(a, os.path.join(room, "alias.html"))
        self.e.claude_log([cc("Write", a, sid="sid-l")])
        out = self.e.run("--record-sources")
        self.assertTrue(out["candidates"][0]["linked"])
        self.assertEqual(out["recorded"], 1)
        self.assertEqual(self.sources()["sources"][a]["session"], "sid-l")

    def test_record_sources_last_write_wins(self):
        self.dot_rooms()
        a = self.e.html("proj/rw.html")
        self.e.claude_log([cc("Write", a, days_ago=3, sid="old")], name="a.jsonl")
        self.e.claude_log([cc("Write", a, days_ago=1, sid="new", cwd="/n")], name="b.jsonl")
        self.e.run("--record-sources")
        e = self.sources()["sources"][a]
        self.assertEqual((e["session"], e["cwd"]), ("new", "/n"))

    def test_record_sources_keeps_newer_replaces_older(self):
        a = self.e.html("proj/rk.html")
        b = self.e.html("proj/rk2.html")
        self.e.claude_log([cc("Write", a, days_ago=1, sid="s-a"),
                           cc("Write", b, days_ago=1, sid="s-b")])
        self.dot_rooms()
        old = {"agent": "codex", "session": "old", "cwd": "/o", "writtenAt": "2000-01-01T00:00:00Z"}
        newer = {"agent": "codex", "session": "newer", "cwd": "/o", "writtenAt": "2999-01-01T00:00:00Z"}
        with open(os.path.join(self.e.home, ".rooms", "sources.json"), "w") as f:
            json.dump({"version": 1, "sources": {a: newer, b: old, "/other": old}}, f)
        out = self.e.run("--record-sources")
        s = self.sources()["sources"]
        self.assertEqual(s[a], newer)
        self.assertEqual(s[b]["session"], "s-b")
        self.assertEqual(s["/other"], old)
        self.assertEqual(out["recorded"], 1)

    def test_record_sources_equal_time_replaced(self):
        a = self.e.html("proj/re.html")
        self.e.claude_log([cc("Write", a, sid="s-eq")])
        t = self.e.run()["candidates"][0]["last_written"]
        self.dot_rooms()
        with open(os.path.join(self.e.home, ".rooms", "sources.json"), "w") as f:
            json.dump({"version": 1, "sources": {a: {"agent": "codex", "session": "x",
                       "cwd": "/o", "writtenAt": t}}}, f)
        self.assertEqual(self.e.run("--record-sources")["recorded"], 1)
        self.assertEqual(self.sources()["sources"][a]["session"], "s-eq")

    def test_record_sources_corrupt_file_replaced(self):
        a = self.e.html("proj/rc.html")
        self.e.claude_log([cc("Write", a, sid="s-c")])
        self.dot_rooms()
        with open(os.path.join(self.e.home, ".rooms", "sources.json"), "w") as f:
            f.write("{")
        self.e.run("--record-sources")
        self.assertEqual(self.sources()["sources"][a]["session"], "s-c")

    def test_record_sources_skips_candidates_without_session(self):
        # the log scanners fall back to the file name, so exercise the helper directly
        sys.path.insert(0, HERE)
        try:
            import find_html
        finally:
            sys.path.remove(HERE)
        t = datetime.now(timezone.utc)
        a = self.e.html("proj/rn.html")
        self.dot_rooms()
        r = find_html.record_sources(self.e.home, [{"path": a}], {a: [(t, "codex", "", None, True)]})
        self.assertEqual(r, {"recorded": 0})
        self.assertEqual(self.sources()["sources"], {})

    def test_record_sources_prefers_last_explicit_write(self):
        # a later Codex shell command that only mentions the path must not take the doc over
        self.dot_rooms()
        a = self.e.html("proj/rx.html")
        self.e.claude_log([cc("Write", a, days_ago=2, cwd="/w", sid="writer")])
        self.e.codex_log([cx_meta("/r", sid="reviewer"), cx_exec("cat %s 2>/dev/null" % a)])
        out = self.e.run("--record-sources")
        self.assertEqual(out["candidates"][0]["agent"], "codex")  # loose match is the last write
        e = self.sources()["sources"][a]
        self.assertEqual((e["agent"], e["session"], e["cwd"]), ("claude-code", "writer", "/w"))

    def test_record_sources_without_dot_rooms_creates_nothing(self):
        a = self.e.html("proj/rd.html")
        self.e.claude_log([cc("Write", a, sid="s-d")])
        out = self.e.run("--record-sources")
        self.assertEqual(len(out["candidates"]), 1)
        self.assertEqual(out["recorded"], 0)
        self.assertIn("no .rooms in", out["record_error"])
        self.assertFalse(os.path.exists(os.path.join(self.e.home, ".rooms")))

    @unittest.skipIf(os.name != "posix" or os.geteuid() == 0, "needs a non-root POSIX user")
    def test_record_failure_still_prints_candidates(self):
        a = self.e.html("proj/rr.html")
        self.e.claude_log([cc("Write", a, sid="s-r")])
        d = self.dot_rooms()
        os.chmod(d, 0o500)
        self.addCleanup(os.chmod, d, 0o700)
        out = self.e.run("--record-sources")
        self.assertEqual(self.paths(out), [a])
        self.assertIsNone(out["recorded"])
        self.assertTrue(out["record_error"])
        self.assertEqual(os.listdir(d), [])

    def test_record_sources_leaves_no_temp_files(self):
        a = self.e.html("proj/rt.html")
        self.e.claude_log([cc("Write", a, sid="s-t")])
        d = self.dot_rooms()
        self.e.run("--record-sources")
        self.e.run("--record-sources")
        self.assertEqual(os.listdir(d), ["sources.json"])

    def test_no_flag_no_file_no_key(self):
        a = self.e.html("proj/rf.html")
        self.e.claude_log([cc("Write", a)])
        out = self.e.run()
        self.assertNotIn("recorded", out)
        self.assertFalse(os.path.exists(os.path.join(self.e.home, ".rooms", "sources.json")))


if __name__ == "__main__":
    unittest.main()
