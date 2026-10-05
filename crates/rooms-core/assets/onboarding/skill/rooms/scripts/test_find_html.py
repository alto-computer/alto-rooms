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
        self.assertEqual(out["version"], 1)

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


if __name__ == "__main__":
    unittest.main()
