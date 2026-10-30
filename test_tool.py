#!/usr/bin/env python3
"""Fixture tests for the meta-benchmark tool. Stdlib only.

Run: python3 test_tool.py
Covers run-muse's session-log harvest and timeline, the UI server's
run selection, timeline loading, error scoping, and overhead clamp,
the local-host check, stale running runs, Ctrl+C handling, the
per-provider default model, Anthropic response parsing, the
delete guard for running runs, endpoint routing, the Claude Code
stream parser, compare round order, API-total model time, dotenv
loading, the BENCH_CLAUDE_MODEL default, the --repeat check, the
terminal compare modes, the paid-run notice, and timeout defaults.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent

# Tests never start the UI, so say so once here: this keeps "UI:"
# lines out of the test output. Tests that exercise the UI pointer
# opt back out locally.
os.environ.setdefault("RUN_MUSE_NO_UI", "1")


def load(name, path):
    spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(path)))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


run_muse = load("run_muse", HERE / "run-muse")
server = load("muse_ui_server", HERE / "server.py")

SESSION_RECORD = {
    "recorded_at": 1792791769858843,
    "payload_type": "runtime.session",
    "payload": {"kind": "run", "event": {
        "kind": "model_completed",
        "duration_ms": 10474,
        "usage": {"input_tokens": 31651, "output_tokens": 35,
                  "cached_tokens": 0, "reasoning_tokens": 25},
    }},
}


class HarvestTest(unittest.TestCase):
    def test_harvest_and_timeline_from_session_log(self):
        with tempfile.TemporaryDirectory() as td:
            sid = "test-session-1"
            log = Path(td) / sid / "session.jsonl"
            log.parent.mkdir(parents=True)
            log.write_text(json.dumps(SESSION_RECORD) + "\n"
                           + json.dumps({"recorded_at": 1792791769858843 + 5_000_000,
                                         "payload_type": "session.end",
                                         "payload": {"kind": "session_end"}}) + "\n")
            old = os.environ.get("MUSE_SESSIONS_DIR")
            os.environ["MUSE_SESSIONS_DIR"] = td
            try:
                calls = run_muse.harvest_calls(sid)
                timeline = run_muse.build_timeline(sid, 16001)
            finally:
                if old is None:
                    os.environ.pop("MUSE_SESSIONS_DIR", None)
                else:
                    os.environ["MUSE_SESSIONS_DIR"] = old
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["duration_ms"], 10474)
            self.assertEqual(calls[0]["input_tokens"], 31651)
            self.assertEqual(calls[0]["output_tokens"], 35)
            self.assertEqual(timeline[0]["wire_ms"], 10474)
            self.assertEqual(timeline[0]["duration_ms"], 5000)

    def test_missing_session_returns_empty(self):
        self.assertEqual(run_muse.harvest_calls("no-such-session"), [])


class ReadLogsTest(unittest.TestCase):
    def test_selection_scopes_events_and_loads_timeline(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-a").mkdir(parents=True)
            (runs / "run-b").mkdir(parents=True)
            base = {"model": "muse-wonder-full-1.0", "provider": "meta",
                    "exit_code": 0, "error": None}
            run_a = dict(base, run_id="run-a", at="2026-01-01T00:00:00+00:00",
                         prompt="first", reply="1", wall_ms=100,
                         calls=[{"duration_ms": 80, "input_tokens": 10,
                                 "output_tokens": 2}])
            run_b = dict(base, run_id="run-b", at="2026-01-02T00:00:00+00:00",
                         prompt="second", reply="2", wall_ms=200,
                         calls=[{"duration_ms": 150, "input_tokens": 20,
                                 "output_tokens": 3}])
            (runs / "run-a" / "report.json").write_text(json.dumps(
                dict(run_a, timeline=[{"operation": "step-a", "duration_ms": 5}])))
            (runs / "run-b" / "report.json").write_text(json.dumps(
                dict(run_b, timeline=[{"operation": "step-b", "duration_ms": 7}])))
            (runs / "index.jsonl").write_text(
                json.dumps(run_a) + "\n" + json.dumps(run_b) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                latest = server.read_logs()
                picked = server.read_logs("run-a")
            finally:
                server.INDEX = old
            self.assertEqual(latest["selected"], "run-b")
            self.assertEqual([s["run_id"] for s in latest["sessions"]],
                             ["run-b", "run-a"])
            self.assertEqual(picked["prompt"], "first")
            self.assertEqual(picked["events"][0]["wire_ms"], 80)
            self.assertEqual(picked["timeline"][0]["operation"], "step-a")


class HostCheckTest(unittest.TestCase):
    def test_cross_site_and_rebinding_requests_rejected(self):
        import http.client
        import threading
        from http.server import HTTPServer
        old_port = server.PORT
        httpd = HTTPServer(("127.0.0.1", 0), server.Handler)
        server.PORT = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            def get(headers):
                conn = http.client.HTTPConnection("127.0.0.1", server.PORT, timeout=5)
                conn.request("GET", "/api/logs", headers=headers)
                resp = conn.getresponse()
                resp.read()
                conn.close()
                return resp.status
            port = server.PORT
            self.assertEqual(get({"Host": f"127.0.0.1:{port}"}), 200)
            self.assertEqual(get({"Host": f"localhost:{port}"}), 200)
            self.assertEqual(get({"Host": "evil.example"}), 403)
            self.assertEqual(get({"Host": f"127.0.0.1:{port}",
                                  "Origin": "https://evil.example"}), 403)
            # Cross-site POST to /api/delete must also be rejected.
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("POST", "/api/delete", body='{"run_id":"x"}',
                         headers={"Host": f"127.0.0.1:{port}",
                                  "Origin": "https://evil.example",
                                  "Content-Type": "application/json"})
            resp = conn.getresponse()
            resp.read()
            conn.close()
            self.assertEqual(resp.status, 403)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.PORT = old_port


class StaticFilesTest(unittest.TestCase):
    def test_static_files_and_spa_fallback(self):
        import http.client
        import threading
        from http.server import HTTPServer
        old_port = server.PORT
        httpd = HTTPServer(("127.0.0.1", 0), server.Handler)
        server.PORT = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            def get(path, headers=None):
                conn = http.client.HTTPConnection(
                    "127.0.0.1", server.PORT, timeout=5)
                conn.request("GET", path, headers=headers or
                             {"Host": f"127.0.0.1:{server.PORT}"})
                resp = conn.getresponse()
                body = resp.read()
                ctype = resp.getheader("Content-Type") or ""
                conn.close()
                return resp.status, ctype, body
            shell = (HERE / "web" / "index.html").read_bytes()
            for path in ("/", "/index.html", "/runs/20260101-abc",
                         "/compare/set1", "/timeline/run-a",
                         "/some/deep/link"):
                status, ctype, body = get(path)
                self.assertEqual(status, 200, path)
                self.assertIn("text/html", ctype, path)
                self.assertEqual(body, shell, path)
            status, ctype, body = get("/app.js")
            self.assertEqual(status, 200)
            self.assertIn("javascript", ctype)
            self.assertEqual(body, (HERE / "web" / "app.js").read_bytes())
            self.assertTrue(body)
            status, ctype, body = get("/style.css")
            self.assertEqual(status, 200)
            self.assertIn("text/css", ctype)
            self.assertEqual(body, (HERE / "web" / "style.css").read_bytes())
            self.assertTrue(body)
            status, ctype, body = get("/api/logs")
            self.assertEqual(status, 200)
            self.assertIn("application/json", ctype)
            self.assertIn(b'"sessions"', body)
            status, _, _ = get("/api/nope")
            self.assertEqual(status, 404)
            status, _, _ = get("/app.js", {"Host": "evil.example"})
            self.assertEqual(status, 403)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.PORT = old_port


class PortHeldTest(unittest.TestCase):
    def test_foreign_server_on_port_prints_message_and_starts_nothing(self):
        # A plain http.server on a random free port is another app:
        # ensure_ui must name the port, start no server and open no tab.
        # Never the default port: tests must not touch a real UI.
        import http.server
        import threading
        httpd = http.server.HTTPServer(
            ("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        old_port, old_url = run_muse.PORT, run_muse.UI_URL
        run_muse.PORT = port
        run_muse.UI_URL = f"http://127.0.0.1:{port}/"
        started, opened = [], []
        try:
            with mock.patch.dict(os.environ):
                os.environ.pop("RUN_MUSE_NO_UI", None)
                with mock.patch.object(run_muse, "start_ui",
                                       lambda: started.append(1)), \
                        mock.patch.object(run_muse.subprocess, "run",
                                          lambda *a, **k: opened.append(a)), \
                        mock.patch("sys.stderr", new_callable=io.StringIO) as err:
                    run_muse.ensure_ui()
                    # No UI line may point at the other app.
                    enabled = run_muse.ui_enabled()
                    suffix = run_muse._ui_suffix()
        finally:
            run_muse.PORT, run_muse.UI_URL = old_port, old_url
            run_muse._ui_blocked = False
            httpd.shutdown()
            httpd.server_close()
        self.assertIn(f"Port {port} is in use by another app", err.getvalue())
        self.assertIn(f"PORT={port + 1} ./run-muse", err.getvalue())
        self.assertEqual(started, [])
        self.assertEqual(opened, [])
        self.assertFalse(enabled)
        self.assertEqual(suffix, "")

    def test_foreign_process_found_on_restart_opens_no_tab(self):
        # Our server answered with an old version, but the pid on the
        # port is not ours: no signal, no restart, no tab, no UI line.
        opened, killed = [], []
        logs = {"version": -1}
        try:
            with mock.patch.dict(os.environ):
                os.environ.pop("RUN_MUSE_NO_UI", None)
                with mock.patch.object(run_muse, "fetch_ui_logs", lambda: logs), \
                        mock.patch.object(run_muse, "_pids_on_port", lambda port: ["4242"]), \
                        mock.patch.object(run_muse, "_pid_cmdline", lambda pid: "python3 -m http.server"), \
                        mock.patch.object(run_muse, "_pid_cwd", lambda pid: "/elsewhere"), \
                        mock.patch.object(run_muse, "start_ui", lambda: killed.append("start")), \
                        mock.patch.object(run_muse.subprocess, "run",
                                          lambda *a, **k: opened.append(a)), \
                        mock.patch("sys.stderr", new_callable=io.StringIO), \
                        mock.patch("sys.stdout", new_callable=io.StringIO):
                    run_muse.ensure_ui()
                    enabled = run_muse.ui_enabled()
        finally:
            run_muse._ui_blocked = False
        self.assertEqual(opened, [])
        self.assertEqual(killed, [])
        self.assertFalse(enabled)


class StaleRunningTest(unittest.TestCase):
    def test_old_running_without_report_is_not_running(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-old").mkdir(parents=True)
            run = {"run_id": "run-old", "at": "2020-01-01T00:00:00+00:00",
                   "prompt": "stuck", "model": "m", "provider": "meta",
                   "session_id": None, "context_mode": "full",
                   "comparison_id": None, "status": "running",
                   "timeout_seconds": 1800, "wall_ms": None,
                   "exit_code": None, "reply": "", "calls": [],
                   "metrics_unavailable": False, "error": None}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs()
            finally:
                server.INDEX = old
            self.assertNotEqual(data["status"], "running")
            self.assertEqual(data["sessions"][0]["status"], "interrupted")


class InterruptTest(unittest.TestCase):
    def test_keyboard_interrupt_writes_final_status(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs, old_fn = run_muse.RUNS, run_muse.run_anthropic
            run_muse.RUNS = runs
            run_muse.run_anthropic = lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt())
            try:
                report = run_muse.run_prompt("hi", provider="anthropic",
                                             model="m", timeout=1800)
            finally:
                run_muse.RUNS, run_muse.run_anthropic = old_runs, old_fn
            self.assertEqual(report["status"], "interrupted")
            entries = [json.loads(l) for l in (runs / "index.jsonl").read_text().splitlines()]
            self.assertEqual(entries[-1]["status"], "interrupted")
            self.assertTrue((runs / report["run_id"] / "report.json").is_file())


class DefaultModelTest(unittest.TestCase):
    def test_default_model_is_per_provider(self):
        with mock.patch.dict(os.environ,
                             {"MUSE_MODEL": "meta-sentinel",
                              "BENCH_CLAUDE_MODEL": "claude-sentinel",
                              "ANTHROPIC_MODEL": "muse-wonder-1.0"}):
            self.assertEqual(run_muse.default_model("meta"), "meta-sentinel")
            self.assertEqual(run_muse.default_model("anthropic"),
                             "claude-sentinel")
            self.assertEqual(run_muse.default_model("claude-code"),
                             "claude-sentinel")
            self.assertEqual(
                run_muse.parse_compare_models(
                    "meta, anthropic, meta:custom-meta, anthropic:custom-claude"),
                [("meta", "meta-sentinel"), ("anthropic", "claude-sentinel"),
                 ("meta", "custom-meta"), ("anthropic", "custom-claude")])

    def test_anthropic_model_env_does_not_change_default(self):
        # Meta's Claude Code setup exports ANTHROPIC_MODEL for a Meta
        # model. That name must not become this tool's Claude default.
        with mock.patch.dict(os.environ,
                             {"ANTHROPIC_MODEL": "muse-wonder-1.0"}):
            os.environ.pop("BENCH_CLAUDE_MODEL", None)
            self.assertNotEqual(run_muse.default_model("anthropic"),
                                "muse-wonder-1.0")
            self.assertNotEqual(run_muse.default_model("claude-code"),
                                "muse-wonder-1.0")


class AnthropicTest(unittest.TestCase):
    def test_cache_tokens_stop_reason_and_max_tokens(self):
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({
                    "model": "claude-test", "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": "4"}],
                    "usage": {"input_tokens": 13, "output_tokens": 14,
                              "cache_read_input_tokens": 25},
                }).encode()

        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode())
            return FakeResponse()

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.dict(os.environ,
                                 {"ANTHROPIC_API_KEY": "test-key",
                                  "ANTHROPIC_MAX_TOKENS": "1234"}):
                with mock.patch.object(run_muse.urllib.request,
                                       "urlopen", fake_urlopen):
                    result = run_muse.run_anthropic("hi", Path(td),
                                                    "claude-test", 30)
        self.assertEqual(captured["body"]["max_tokens"], 1234)
        self.assertEqual(result["calls"][0]["cached_tokens"], 25)
        self.assertEqual(result["calls"][0]["stop_reason"], "end_turn")
        self.assertEqual(result["reply"], "4")


class ErrorScopeTest(unittest.TestCase):
    def test_errors_scoped_to_selected_run(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-a").mkdir(parents=True)
            (runs / "run-b").mkdir(parents=True)
            base = {"model": "m", "provider": "meta", "reply": "",
                    "wall_ms": 100, "calls": []}
            run_a = dict(base, run_id="run-a", at="2026-01-01T00:00:00+00:00",
                         prompt="first", exit_code=1, error="boom-a")
            run_b = dict(base, run_id="run-b", at="2026-01-02T00:00:00+00:00",
                         prompt="second", exit_code=1, error="boom-b")
            (runs / "index.jsonl").write_text(
                json.dumps(run_a) + "\n" + json.dumps(run_b) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                picked = server.read_logs("run-a")
            finally:
                server.INDEX = old
            self.assertEqual([e["error_type"] for e in picked["errors"]],
                             ["boom-a"])
            self.assertEqual(picked["errors"][0]["operation"], "run-a")


class DeleteRunTest(unittest.TestCase):
    def test_delete_refuses_running_run(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-live").mkdir(parents=True)
            (runs / "run-done").mkdir(parents=True)
            live = {"run_id": "run-live", "status": "running"}
            done = {"run_id": "run-done", "status": "completed"}
            (runs / "index.jsonl").write_text(
                json.dumps(live) + "\n" + json.dumps(done) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                ok, reason = server.delete_run("run-live")
                self.assertFalse(ok)
                self.assertIn("running", reason)
                self.assertTrue((runs / "run-live").is_dir())
                self.assertIn("run-live",
                              (runs / "index.jsonl").read_text())
                ok, reason = server.delete_run("run-done")
                self.assertTrue(ok)
                self.assertFalse((runs / "run-done").exists())
            finally:
                server.INDEX = old

    def test_delete_allows_stale_running_run(self):
        # A crashed run stays "running" in the index forever. The page
        # shows it as interrupted, so it must be deletable.
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-crashed").mkdir(parents=True)
            crashed = {"run_id": "run-crashed", "status": "running",
                       "at": "2020-01-01T00:00:00+00:00",
                       "timeout_seconds": 60}
            (runs / "index.jsonl").write_text(json.dumps(crashed) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                ok, reason = server.delete_run("run-crashed")
                self.assertTrue(ok, reason)
                self.assertFalse((runs / "run-crashed").exists())
            finally:
                server.INDEX = old


class NoInventedZerosTest(unittest.TestCase):
    def _read(self, run):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        runs = Path(td.name) / "muse-runs"
        (runs / run["run_id"]).mkdir(parents=True)
        (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
        old = server.INDEX
        server.INDEX = runs / "index.jsonl"
        try:
            return server.read_logs(run["run_id"])
        finally:
            server.INDEX = old

    def test_no_durations_and_no_api_ms_is_none_not_zero(self):
        # Echo shape: a call record exists but nothing timed it.
        data = self._read({
            "run_id": "run-echo", "at": "2026-01-01T00:00:00+00:00",
            "prompt": "hi", "model": "echo", "provider": "echo",
            "exit_code": 0, "error": None, "reply": "hi", "wall_ms": 900,
            "status": "completed",
            "calls": [{"duration_ms": None, "input_tokens": 1,
                       "output_tokens": 1}]})
        self.assertIsNone(data["model_ms"])
        self.assertIsNone(data["sessions"][0]["model_ms"])
        self.assertIsNone(data["sessions"][0]["overhead_ms"])
        self.assertIsNone(data["time_split"]["model_ms"])

    def test_no_calls_at_all_is_none(self):
        data = self._read({
            "run_id": "run-empty", "at": "2026-01-01T00:00:00+00:00",
            "prompt": "hi", "model": "m", "provider": "meta",
            "exit_code": 0, "error": None, "reply": "", "wall_ms": 900,
            "status": "interrupted", "calls": []})
        self.assertIsNone(data["model_ms"])
        self.assertIsNone(data["sessions"][0]["model_ms"])

    def test_a_real_zero_stays_zero(self):
        data = self._read({
            "run_id": "run-zero", "at": "2026-01-01T00:00:00+00:00",
            "prompt": "hi", "model": "m", "provider": "meta",
            "exit_code": 0, "error": None, "reply": "", "wall_ms": 900,
            "status": "completed",
            "calls": [{"duration_ms": 0, "input_tokens": 1,
                       "output_tokens": 1}]})
        self.assertEqual(data["model_ms"], 0)
        self.assertEqual(data["sessions"][0]["model_ms"], 0)
        self.assertEqual(data["sessions"][0]["overhead_ms"], 900)

    def test_terminal_summary_prints_model_dash_when_unrecorded(self):
        import contextlib
        report = {"status": "interrupted", "provider": "meta",
                  "model": "m", "metrics_unavailable": False,
                  "error": None, "timeout_seconds": 5, "run_id": "r-x"}
        r = {"wall_ms": 5000, "calls": [{"duration_ms": None,
                                        "input_tokens": None,
                                        "output_tokens": None}],
             "api_ms": None, "totals": None, "reply": "",
             "needs_approval": None}
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as td, \
                contextlib.redirect_stdout(out):
            run_muse.print_summary(report, r, Path(td))
        self.assertIn("model –", out.getvalue())
        self.assertNotIn("model 0 ms", out.getvalue())


class OverheadClampTest(unittest.TestCase):
    def test_overhead_clamped_at_zero(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-a").mkdir(parents=True)
            run = {"run_id": "run-a", "at": "2026-01-01T00:00:00+00:00",
                   "prompt": "first", "model": "m", "provider": "meta",
                   "exit_code": 0, "error": None, "reply": "1",
                   "wall_ms": 50,
                   "calls": [{"duration_ms": 80, "input_tokens": 10,
                              "output_tokens": 2}]}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs()
            finally:
                server.INDEX = old
            self.assertEqual(data["sessions"][0]["model_ms"], 80)
            self.assertEqual(data["sessions"][0]["overhead_ms"], 0)


class EndpointTest(unittest.TestCase):
    def test_muse_models_route_to_meta(self):
        with mock.patch.dict(os.environ,
                             {"MODEL_API_KEY": "meta-key",
                              "ANTHROPIC_API_KEY": "claude-key",
                              "META_BASE_URL": "https://meta.example/",
                              "ANTHROPIC_BASE_URL": "https://claude.example/"}):
            self.assertEqual(run_muse.endpoint_for("muse-wonder-full-1.0"),
                             ("https://meta.example", "meta-key"))
            self.assertEqual(run_muse.endpoint_for("claude-sonnet-5-5"),
                             ("https://claude.example", "claude-key"))


class ClaudeStreamTest(unittest.TestCase):
    def test_fixture_maps_to_calls_and_totals(self):
        lines = (HERE / "fixtures" / "claude-code-stream.jsonl") \
            .read_text().splitlines()
        stamped = [(i * 100, line) for i, line in enumerate(lines)]
        parsed = run_muse.parse_claude_stream(stamped)
        self.assertEqual(len(parsed["calls"]), 2)
        self.assertEqual([c["input_tokens"] for c in parsed["calls"]],
                         [1682, 1787])
        self.assertEqual([c["cached_tokens"] for c in parsed["calls"]],
                         [1495, 1678])
        self.assertEqual([c["duration_ms"] for c in parsed["calls"]],
                         [None, None])
        self.assertEqual([c["output_tokens"] for c in parsed["calls"]],
                         [None, None])
        self.assertEqual(parsed["totals"],
                         {"input_tokens": 3469, "output_tokens": 139,
                          "cached_tokens": 3173})
        self.assertEqual(parsed["api_ms"], 2736)
        self.assertEqual(parsed["ttft_ms"], 1327)
        self.assertEqual(parsed["num_turns"], 2)
        self.assertFalse(parsed["is_error"])
        self.assertTrue(parsed["reply"].startswith("I created `hello.py`"))
        self.assertEqual(len(parsed["timeline"]), 6)
        self.assertEqual([t["duration_ms"] for t in parsed["timeline"]],
                         [100, 100, 100, 100, 100, 0])
        self.assertTrue(all(t["wire_ms"] is None
                            for t in parsed["timeline"]))

    def test_synthetic_and_zero_usage_are_not_counted(self):
        zero = {"input_tokens": 0, "output_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0}
        events = [
            {"type": "assistant", "message": {
                "id": "msg_meta", "model": "muse-wonder-1.0", "usage": zero}},
            {"type": "assistant", "message": {
                "id": "msg_err", "model": "<synthetic>", "usage": zero}},
            {"type": "result", "subtype": "success", "is_error": False,
             "result": "4", "duration_api_ms": 4105,
             "usage": {"input_tokens": 1370, "output_tokens": 15}},
        ]
        stamped = [(i * 100, json.dumps(e)) for i, e in enumerate(events)]
        parsed = run_muse.parse_claude_stream(stamped)
        self.assertEqual(len(parsed["calls"]), 1)
        self.assertIsNone(parsed["calls"][0]["input_tokens"])
        self.assertIsNone(parsed["calls"][0]["cached_tokens"])
        self.assertEqual(parsed["usage_model"], "muse-wonder-1.0")
        self.assertEqual(parsed["totals"]["input_tokens"], 1370)


class CompareScheduleTest(unittest.TestCase):
    def test_repeat_alternates_order(self):
        models = [("meta", "a"), ("claude-code", "b"), ("anthropic", "c")]
        self.assertEqual(run_muse.compare_schedule(models, 3), [
            (1, models),
            (2, [("anthropic", "c"), ("claude-code", "b"), ("meta", "a")]),
            (3, models),
        ])


class ApiMsTest(unittest.TestCase):
    def test_server_uses_api_ms_and_totals(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-cc").mkdir(parents=True)
            run = {"run_id": "run-cc", "at": "2026-01-01T00:00:00+00:00",
                   "prompt": "hi", "model": "claude-sonnet-5-5",
                   "provider": "claude-code", "exit_code": 0,
                   "error": None, "reply": "ok", "wall_ms": 3329,
                   "api_ms": 2736, "ttft_ms": 1327,
                   "totals": {"input_tokens": 3469, "output_tokens": 139,
                              "cached_tokens": 3173},
                   "calls": [
                       {"duration_ms": None, "input_tokens": 1682,
                        "output_tokens": None, "cached_tokens": 1495},
                       {"duration_ms": None, "input_tokens": 1787,
                        "output_tokens": None, "cached_tokens": 1678}]}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs()
            finally:
                server.INDEX = old
            self.assertEqual(data["model_ms"], 2736)
            self.assertEqual(data["sessions"][0]["model_ms"], 2736)
            self.assertEqual(data["sessions"][0]["overhead_ms"], 593)
            self.assertEqual(data["sessions"][0]["input_tokens"], 3469)
            self.assertEqual(data["sessions"][0]["output_tokens"], 139)
            self.assertIsNone(data["events"][0]["wire_ms"])


class DotenvTest(unittest.TestCase):
    def test_parsing_and_env_wins(self):
        with tempfile.TemporaryDirectory() as td:
            env_file = Path(td) / ".env"
            env_file.write_text(
                "# a comment\n"
                "\n"
                "BENCH_DOTENV_PLAIN=plain-value\n"
                "BENCH_DOTENV_QUOTED=\"double quoted\"\n"
                "BENCH_DOTENV_SINGLE='single quoted'\n"
                "BENCH_DOTENV_SPACED = spaced value \n"
                "BENCH_DOTENV_EQUALS=a=b\n"
                "BENCH_DOTENV_WINS=from-file\n"
                "a line without an equals sign\n")
            with mock.patch.dict(os.environ,
                                 {"BENCH_DOTENV_WINS": "from-env"}):
                for key in ("BENCH_DOTENV_PLAIN", "BENCH_DOTENV_QUOTED",
                            "BENCH_DOTENV_SINGLE", "BENCH_DOTENV_SPACED",
                            "BENCH_DOTENV_EQUALS"):
                    os.environ.pop(key, None)
                run_muse.load_dotenv(env_file)
                self.assertEqual(os.environ["BENCH_DOTENV_PLAIN"],
                                 "plain-value")
                self.assertEqual(os.environ["BENCH_DOTENV_QUOTED"],
                                 "double quoted")
                self.assertEqual(os.environ["BENCH_DOTENV_SINGLE"],
                                 "single quoted")
                self.assertEqual(os.environ["BENCH_DOTENV_SPACED"],
                                 "spaced value")
                self.assertEqual(os.environ["BENCH_DOTENV_EQUALS"], "a=b")
                self.assertEqual(os.environ["BENCH_DOTENV_WINS"], "from-env")

    def test_missing_file_is_a_noop(self):
        with tempfile.TemporaryDirectory() as td:
            run_muse.load_dotenv(Path(td) / ".env")


class RepeatArgTest(unittest.TestCase):
    def test_repeat_without_compare_is_an_error(self):
        import contextlib
        import io
        err = io.StringIO()
        with mock.patch.object(sys, "argv",
                               ["run-muse", "--repeat", "2", "hi"]):
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    run_muse.main()
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("--repeat needs --compare", err.getvalue())

    def _main_error(self, argv):
        import contextlib
        import io
        err = io.StringIO()
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    run_muse.main()
        self.assertEqual(ctx.exception.code, 2)
        return err.getvalue()

    def test_compare_without_mode_is_an_error(self):
        err = self._main_error(["run-muse", "--compare"])
        self.assertIn("expected one argument", err)
        self.assertIn("{meta,claude,custom}", err)

    def test_compare_with_wrong_mode_is_an_error(self):
        err = self._main_error(["run-muse", "--compare", "bogus", "hi"])
        self.assertIn("invalid choice", err)
        err = self._main_error(["run-muse", "--compare", "what is 2+2"])
        self.assertIn("invalid choice", err)


class TerminalOutputTest(unittest.TestCase):
    def _summary_out(self, report, r, env=None):
        import contextlib
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as td, \
                mock.patch.dict(os.environ, env or {}, clear=False), \
                contextlib.redirect_stdout(out):
            if not env or "RUN_MUSE_NO_UI" not in env:
                os.environ.pop("RUN_MUSE_NO_UI", None)
            run_muse.print_summary(report, r, Path(td))
        return out.getvalue()

    def _report(self, **over):
        report = {"status": "completed", "provider": "meta", "model": "m",
                  "metrics_unavailable": False, "error": None,
                  "timeout_seconds": 5, "run_id": "r-x"}
        report.update(over)
        return report

    def _result(self, **over):
        r = {"wall_ms": 10, "calls": [{"duration_ms": 5,
                                      "input_tokens": 1,
                                      "output_tokens": 1}],
             "api_ms": None, "totals": None, "reply": "",
             "needs_approval": None}
        r.update(over)
        return r

    def test_long_reply_gets_a_full_reply_marker(self):
        out = self._summary_out(self._report(), self._result(reply="x" * 600))
        self.assertIn("x" * 500, out)
        self.assertIn("… (full reply: muse-runs/r-x/report.json)", out)
        self.assertNotIn("x" * 501, out)
        short = self._summary_out(self._report(), self._result(reply="short"))
        self.assertIn("short", short)
        self.assertNotIn("full reply", short)

    def test_ui_line_skipped_when_no_ui_is_set(self):
        hidden = self._summary_out(self._report(), self._result(),
                                   env={"RUN_MUSE_NO_UI": "1"})
        self.assertNotIn("UI:", hidden)
        shown = self._summary_out(self._report(), self._result(), env={})
        self.assertIn("UI:", shown)

    def test_stdout_flushed_before_error_on_stderr(self):
        events = []

        class FakeStream:
            def __init__(self, name):
                self.name = name

            def write(self, text):
                if text.strip():
                    events.append((self.name, text.strip()))
                return len(text)

            def flush(self):
                events.append((self.name, "FLUSH"))

        report = self._report(status="failed", error="boom")
        with tempfile.TemporaryDirectory() as td, \
                mock.patch("sys.stdout", FakeStream("out")), \
                mock.patch("sys.stderr", FakeStream("err")):
            run_muse.print_summary(report, self._result(), Path(td))
        flush_at = events.index(("out", "FLUSH"))
        error_at = next(i for i, e in enumerate(events)
                        if e[0] == "err" and "boom" in e[1])
        self.assertLess(flush_at, error_at)

    def test_compare_ends_with_a_closing_line(self):
        import contextlib
        import re
        statuses = iter([{"status": "completed"}, {"status": "failed"}])
        out = io.StringIO()
        with mock.patch.dict(os.environ):
            os.environ.pop("RUN_MUSE_NO_UI", None)
            with mock.patch.object(
                    run_muse, "compare_models_for",
                    lambda mode: [("meta", "a"), ("meta", "b")]), \
                    mock.patch.object(run_muse, "run_prompt",
                                      lambda *a, **k: next(statuses)), \
                    contextlib.redirect_stdout(out):
                run_muse.run_compare("hi", "meta", False, None, 1)
        match = re.search(
            r"Compare set ([0-9a-f]{8}) done: 1 completed of 2\. "
            r"UI: \S+compare/\1", out.getvalue())
        self.assertIsNotNone(match, out.getvalue())

    def test_help_mentions_ctrl_c(self):
        text = run_muse.handle_command("/help", {"mode": "single"})["text"]
        self.assertIn("Ctrl+C stops a run", text)


class SigintTest(unittest.TestCase):
    def test_main_restores_default_sigint_handler(self):
        # A launcher started in the background of a non-interactive
        # shell inherits SIGINT as ignored, so kill -INT would do
        # nothing. main() must restore the default handler.
        import signal as signal_mod
        previous = signal_mod.signal(signal_mod.SIGINT, signal_mod.SIG_IGN)
        try:
            with mock.patch.object(sys, "argv",
                                   ["run-muse", "--repeat", "2", "hi"]):
                with self.assertRaises(SystemExit):
                    run_muse.main()
            self.assertEqual(signal_mod.getsignal(signal_mod.SIGINT),
                             signal_mod.default_int_handler)
        finally:
            signal_mod.signal(signal_mod.SIGINT, previous)


class ExitCodeTest(unittest.TestCase):
    def test_status_to_exit_code_mapping(self):
        self.assertEqual(run_muse.exit_code_for("completed"), 0)
        self.assertEqual(run_muse.exit_code_for("interrupted"), 130)
        for status in ("failed", "timeout", "needs_approval"):
            self.assertEqual(run_muse.exit_code_for(status), 1, status)

    def test_single_run_main_returns_status_code(self):
        for status, code in (("completed", 0), ("failed", 1),
                             ("timeout", 1), ("needs_approval", 1),
                             ("interrupted", 130)):
            with mock.patch.object(sys, "argv", ["run-muse", "hi"]), \
                    mock.patch.object(run_muse, "ensure_ui", lambda: None), \
                    mock.patch.object(
                        run_muse, "run_prompt",
                        lambda *a, **k: {"status": status}):
                self.assertEqual(run_muse.main(), code, status)

    def test_compare_main_returns_compare_code(self):
        with mock.patch.object(sys, "argv",
                               ["run-muse", "--compare", "meta", "hi"]), \
                mock.patch.object(run_muse, "ensure_ui", lambda: None), \
                mock.patch.object(run_muse, "run_compare",
                                  lambda *a, **k: 1):
            self.assertEqual(run_muse.main(), 1)

    def test_run_compare_aggregates_statuses(self):
        statuses = iter([{"status": "completed"}, {"status": "failed"}])
        with mock.patch.object(run_muse, "compare_models_for",
                               lambda mode: [("meta", "a"), ("meta", "b")]), \
                mock.patch.object(run_muse, "run_prompt",
                                  lambda *a, **k: next(statuses)):
            self.assertEqual(
                run_muse.run_compare("hi", "meta", False, None, 1), 1)
        statuses = iter([{"status": "completed"},
                         {"status": "interrupted"}])
        with mock.patch.object(run_muse, "compare_models_for",
                               lambda mode: [("meta", "a"), ("meta", "b")]), \
                mock.patch.object(run_muse, "run_prompt",
                                  lambda *a, **k: next(statuses)):
            self.assertEqual(
                run_muse.run_compare("hi", "meta", False, None, 1), 130)
        statuses = iter([{"status": "completed"}, {"status": "completed"}])
        with mock.patch.object(run_muse, "compare_models_for",
                               lambda mode: [("meta", "a"), ("meta", "b")]), \
                mock.patch.object(run_muse, "run_prompt",
                                  lambda *a, **k: next(statuses)):
            self.assertEqual(
                run_muse.run_compare("hi", "meta", False, None, 1), 0)

    def test_prompt_loop_still_exits_zero(self):
        with mock.patch.object(sys, "argv", ["run-muse"]), \
                mock.patch.object(run_muse, "ensure_ui", lambda: None), \
                mock.patch("builtins.input", side_effect=EOFError):
            self.assertEqual(run_muse.main(), 0)


class CompareModelsForTest(unittest.TestCase):
    def test_preset_defaults(self):
        with mock.patch.dict(os.environ, {}):
            for key in ("COMPARE_META", "COMPARE_CLAUDE"):
                os.environ.pop(key, None)
            self.assertEqual(run_muse.compare_models_for("meta"), [
                ("meta", "muse-wonder-full-1.0"),
                ("meta", "muse-wonder-1.0")])
            self.assertEqual(run_muse.compare_models_for("claude"), [
                ("claude-code", "muse-wonder-1.0"),
                ("claude-code", "claude-sonnet-5-5")])

    def test_env_overrides_and_custom(self):
        with mock.patch.dict(os.environ, {
                "COMPARE_META": "meta:a,meta:b",
                "COMPARE_CLAUDE": "claude-code:c",
                "COMPARE_MODELS": "meta:d,anthropic:e"}):
            self.assertEqual(run_muse.compare_models_for("meta"),
                             [("meta", "a"), ("meta", "b")])
            self.assertEqual(run_muse.compare_models_for("claude"),
                             [("claude-code", "c")])
            self.assertEqual(run_muse.compare_models_for("custom"),
                             [("meta", "d"), ("anthropic", "e")])
            self.assertEqual(run_muse.compare_models_for(None),
                             [("meta", "d"), ("anthropic", "e")])

    def test_unknown_mode_raises(self):
        with self.assertRaises(ValueError) as ctx:
            run_muse.compare_models_for("bogus")
        self.assertIn("meta, claude, custom", str(ctx.exception))


class HandleCommandTest(unittest.TestCase):
    def test_mode_show_switch_and_invalid(self):
        state = {"mode": "single"}
        shown = run_muse.handle_command("/mode", state)
        self.assertEqual(shown["action"], "message")
        self.assertIn("single", shown["text"])
        switched = run_muse.handle_command("/mode meta", state)
        self.assertEqual(switched["mode"], "meta")
        self.assertIn("meta vs meta", switched["text"])
        self.assertIn("muse-wonder-full-1.0", switched["text"])
        # Pure: the caller's state is not mutated.
        self.assertEqual(state, {"mode": "single"})
        bad = run_muse.handle_command("/mode bogus", {"mode": "claude"})
        self.assertEqual(bad["mode"], "claude")
        self.assertIn("Unknown mode", bad["text"])
        back = run_muse.handle_command("/mode single", {"mode": "meta"})
        self.assertEqual(back["mode"], "single")

    def test_help_quit_prompt_and_empty(self):
        help_result = run_muse.handle_command("/help", {"mode": "single"})
        self.assertEqual(help_result["action"], "message")
        self.assertIn("/mode single|meta|claude|custom", help_result["text"])
        self.assertEqual(
            run_muse.handle_command("/quit", {"mode": "meta"})["action"],
            "quit")
        prompt = run_muse.handle_command("what is 2+2", {"mode": "meta"})
        self.assertEqual(prompt, {"action": "prompt", "mode": "meta",
                                  "text": "what is 2+2"})
        self.assertEqual(
            run_muse.handle_command("  ", {"mode": "single"})["action"],
            "none")


class CompareModeRecordTest(unittest.TestCase):
    def test_run_records_compare_mode(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs, old_fn = run_muse.RUNS, run_muse.run_anthropic
            run_muse.RUNS = runs
            run_muse.run_anthropic = lambda *a, **k: \
                (_ for _ in ()).throw(KeyboardInterrupt())
            try:
                report = run_muse.run_prompt(
                    "hi", provider="anthropic", model="m",
                    comparison_id="set1", compare_round=2,
                    compare_mode="claude")
                single = run_muse.run_prompt(
                    "hi", provider="anthropic", model="m")
            finally:
                run_muse.RUNS, run_muse.run_anthropic = old_runs, old_fn
            self.assertEqual(report["compare_mode"], "claude")
            self.assertIsNone(single["compare_mode"])
            entries = [json.loads(l) for l in
                       (runs / "index.jsonl").read_text().splitlines()]
            by_id = {e["run_id"]: e for e in entries}
            self.assertEqual(by_id[report["run_id"]]["compare_mode"],
                             "claude")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs(report["run_id"])
            finally:
                server.INDEX = old
            picked = next(s for s in data["sessions"]
                          if s["run_id"] == report["run_id"])
            self.assertEqual(picked["compare_mode"], "claude")


def _completed(**overrides):
    result = {"session_id": None, "wall_ms": 1, "exit_code": 0,
              "timed_out": False, "interrupted": False, "reply": "",
              "calls": [], "timeline": [], "command": "fake",
              "usage_model": None}
    result.update(overrides)
    return result


class RaceTest(unittest.TestCase):
    """Race mode: parallel compare legs, stops, stamps (stubbed)."""

    def _compare(self, *args, **kwargs):
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            return run_muse.run_compare(*args, **kwargs)

    def test_legs_overlap_and_rounds_stay_sequential(self):
        import threading
        import time
        barrier = threading.Barrier(2)
        log = []
        lock = threading.Lock()

        def fake_run_prompt(prompt, provider=None, model=None, **kwargs):
            with lock:
                log.append((kwargs.get("compare_round"), "start",
                            time.monotonic()))
            barrier.wait(timeout=5)
            with lock:
                log.append((kwargs.get("compare_round"), "end",
                            time.monotonic()))
            return {"status": "completed"}

        with mock.patch.object(run_muse, "run_prompt", fake_run_prompt), \
                mock.patch.object(run_muse, "compare_models_for",
                                  lambda mode: [("meta", "a"),
                                                ("meta", "b")]):
            code = self._compare("hi", "meta", False, None, 2, race=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(log), 8)
        r1_end = max(t for r, kind, t in log if r == 1 and kind == "end")
        r2_start = min(t for r, kind, t in log
                       if r == 2 and kind == "start")
        self.assertGreaterEqual(r2_start, r1_end)

    def test_race_index_parseable_and_stamped(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            fake = lambda *a, **k: run_muse._empty_result(  # noqa: E731
                "fake", exit_code=0, wall_ms=7)
            with mock.patch.object(run_muse, "RUNS", runs), \
                    mock.patch.object(run_muse, "run_anthropic", fake), \
                    mock.patch.object(
                        run_muse, "compare_models_for",
                        lambda mode: [("anthropic", "m1"),
                                      ("anthropic", "m2")]):
                self.assertEqual(self._compare(
                    "hi", "custom", False, None, 1, race=True), 0)
                self.assertEqual(self._compare(
                    "hi", "custom", False, None, 1, race=False), 0)
            entries = [json.loads(l) for l in
                       (runs / "index.jsonl").read_text().splitlines()]
            finals = {}
            for e in entries:
                finals[e["run_id"]] = e
            raced = [e for e in finals.values() if e.get("raced")]
            plain = [e for e in finals.values() if not e.get("raced")]
            self.assertEqual(len(raced), 2)
            self.assertEqual(len(plain), 2)
            self.assertTrue(all(e["comparison_id"] for e in raced))
            self.assertTrue(all(e["status"] == "completed"
                                for e in finals.values()))

    def test_interrupted_leg_rolls_up_130(self):
        def fake_run_prompt(prompt, provider=None, model=None, **kwargs):
            return {"status": "interrupted" if model == "b"
                    else "completed"}

        with mock.patch.object(run_muse, "run_prompt", fake_run_prompt), \
                mock.patch.object(run_muse, "compare_models_for",
                                  lambda mode: [("meta", "a"),
                                                ("meta", "b")]):
            code = self._compare("hi", "meta", False, None, 1, race=True)
        self.assertEqual(code, 130)

    def test_stop_event_stops_the_process(self):
        import threading
        import time
        stop = threading.Event()
        timer = threading.Timer(0.3, stop.set)
        with tempfile.TemporaryDirectory() as td:
            timer.start()
            try:
                result = run_muse.run_process(
                    ["sh", "-c", "sleep 5"], Path(td), dict(os.environ),
                    Path(td) / "out.log", timeout=10, stop_event=stop)
            finally:
                timer.cancel()
        self.assertTrue(result["interrupted"])
        self.assertLess(result["wall_ms"], 3000)
        self.assertGreaterEqual(result["wall_ms"], 250)

    def test_new_run_dir_retries_on_collision(self):
        class FakeUUID:
            def __init__(self, hexed):
                self.hex = hexed

        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            fakes = [FakeUUID("a" * 32), FakeUUID("a" * 32),
                     FakeUUID("b" * 32)]
            with mock.patch.object(run_muse, "RUNS", runs), \
                    mock.patch.object(run_muse.uuid, "uuid4",
                                      side_effect=fakes):
                first, first_dir = run_muse.new_run_dir()
                second, second_dir = run_muse.new_run_dir()
            self.assertNotEqual(first, second)
            self.assertTrue(first_dir.is_dir())
            self.assertTrue(second_dir.is_dir())

    def _main_error(self, argv):
        import contextlib
        err = io.StringIO()
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    run_muse.main()
        self.assertEqual(ctx.exception.code, 2)
        return err.getvalue()

    def test_race_without_compare_is_an_error(self):
        err = self._main_error(["run-muse", "--race", "hi"])
        self.assertIn("--race needs --compare", err)

    def test_server_session_row_carries_raced(self):
        base = {"run_id": "x", "at": None, "prompt": "", "model": "m",
                "wall_ms": None, "calls": [], "provider": "meta"}
        self.assertTrue(server.session_row(
            dict(base, raced=True))["raced"])
        self.assertFalse(server.session_row(base)["raced"])


class SuiteTest(unittest.TestCase):
    def _write_suite(self, td, data):
        path = Path(td) / "suite.json"
        path.write_text(json.dumps(data) if not isinstance(data, str)
                        else data)
        return path

    def test_load_suite_entries_and_defaults(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write_suite(td, {"prompts": [
                {"name": "sky", "prompt": "why blue",
                 "minimal": True},
                {"name": "tools", "prompt": "count lines",
                 "provider": "meta", "model": "fake-m"},
            ]})
            entries = run_muse.load_suite(path)
        self.assertEqual([e["name"] for e in entries], ["sky", "tools"])
        self.assertEqual(entries[0]["provider"],
                         run_muse.DEFAULT_PROVIDER)
        self.assertIsNone(entries[0]["model"])
        self.assertTrue(entries[0]["minimal"])
        self.assertFalse(entries[1]["minimal"])
        self.assertEqual(entries[1]["model"], "fake-m")

    def test_load_suite_rejects_bad_files(self):
        with tempfile.TemporaryDirectory() as td:
            cases = [
                "{not json",
                {"prompts": []},
                {"prompts": [{"name": "x"}]},
                {"prompts": [{"name": "x", "prompt": "a"},
                             {"name": "x", "prompt": "b"}]},
            ]
            for data in cases:
                with self.assertRaises(ValueError):
                    run_muse.load_suite(self._write_suite(td, data))
            with self.assertRaises(ValueError):
                run_muse.load_suite(Path(td) / "missing.json")
            with self.assertRaises(ValueError) as ctx:
                run_muse.load_suite(self._write_suite(
                    td, {"prompts": [{"name": "x", "prompt": "a"},
                                     {"name": "x", "prompt": "b"}]}))
            self.assertIn("duplicate", str(ctx.exception))

    def test_run_records_suite_fields(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs, old_fn = run_muse.RUNS, run_muse.run_anthropic
            run_muse.RUNS = runs
            run_muse.run_anthropic = lambda *a, **k: \
                (_ for _ in ()).throw(KeyboardInterrupt())
            try:
                report = run_muse.run_prompt(
                    "hi", provider="anthropic", model="m",
                    suite_id="suite1", suite_prompt="sky")
                single = run_muse.run_prompt(
                    "hi", provider="anthropic", model="m")
            finally:
                run_muse.RUNS, run_muse.run_anthropic = old_runs, old_fn
            self.assertEqual(report["suite_id"], "suite1")
            self.assertEqual(report["suite_prompt"], "sky")
            self.assertIsNone(single["suite_id"])
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs(report["run_id"])
            finally:
                server.INDEX = old
            picked = next(s for s in data["sessions"]
                          if s["run_id"] == report["run_id"])
            self.assertEqual(picked["suite_id"], "suite1")
            self.assertEqual(picked["suite_prompt"], "sky")

    def test_run_suite_repeats_each_entry_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write_suite(td, {"prompts": [
                {"name": "a", "prompt": "pa"},
                {"name": "b", "prompt": "pb", "minimal": True},
            ]})
            calls = []

            def fake_run(prompt, **kwargs):
                calls.append((prompt, kwargs))
                status = "failed" if prompt == "pb" else "completed"
                return {"status": status}

            old = (run_muse.run_prompt, run_muse.RUNS,
                   run_muse.harness_version)
            run_muse.run_prompt = fake_run
            run_muse.RUNS = Path(td) / "no-runs"
            run_muse.harness_version = lambda p: "v-now"
            try:
                code = run_muse.run_suite(path, timeout=9, repeat=2)
            finally:
                (run_muse.run_prompt, run_muse.RUNS,
                 run_muse.harness_version) = old
        self.assertEqual(code, 1)
        self.assertEqual([c[0] for c in calls], ["pa", "pb", "pa", "pb"])
        self.assertTrue(all(c[1]["suite_id"] for c in calls))
        self.assertEqual(len({c[1]["suite_id"] for c in calls}), 1)
        self.assertEqual(calls[1][1]["suite_prompt"], "b")
        self.assertTrue(calls[1][1]["minimal"])
        self.assertFalse(calls[0][1]["minimal"])

    def test_suite_version_notice_only_on_change(self):
        self.assertIsNone(run_muse.suite_version_notice(
            None, "v2", "meta"))
        self.assertIsNone(run_muse.suite_version_notice(
            "v1", "v1", "meta"))
        self.assertIsNone(run_muse.suite_version_notice(
            "v1", None, "meta"))
        notice = run_muse.suite_version_notice("v1", "v2", "meta")
        self.assertIn("was v1, now v2", notice)

    def test_suite_flag_rejects_prompt_and_compare(self):
        import contextlib
        for argv in (["run-muse", "hi", "--suite"],
                     ["run-muse", "--suite", "--compare", "meta"]):
            err = io.StringIO()
            with mock.patch.object(sys, "argv", argv):
                with contextlib.redirect_stderr(err):
                    with self.assertRaises(SystemExit) as ctx:
                        run_muse.main()
            self.assertEqual(ctx.exception.code, 2)
            self.assertIn("--suite takes no prompt", err.getvalue())


class PricingTest(unittest.TestCase):
    def test_parse_pricing_shapes(self):
        self.assertEqual(run_muse.parse_pricing(None), {})
        self.assertEqual(run_muse.parse_pricing(""), {})
        flat = run_muse.parse_pricing(
            {"input_per_mtok": 4, "output_per_mtok": 20})
        self.assertEqual(flat["*"]["input_per_mtok"], 4.0)
        by_model = run_muse.parse_pricing(
            '{"m1": {"input_per_mtok": 1, "output_per_mtok": 2}}')
        self.assertEqual(by_model["m1"]["output_per_mtok"], 2.0)

    def test_parse_pricing_rejects_bad_values(self):
        for raw in ("{not json", [], {"m": {"input_per_mtok": -1,
                                           "output_per_mtok": 2}},
                    {"m": {"input_per_mtok": 1}},
                    {"m": {"input_per_mtok": True,
                           "output_per_mtok": 2}}):
            with self.assertRaises(ValueError):
                run_muse.parse_pricing(raw)

    def test_compute_cost_from_totals_and_calls(self):
        pricing = run_muse.parse_pricing(
            {"m": {"input_per_mtok": 4, "output_per_mtok": 20}})
        cost, used = run_muse.compute_cost(
            "m", {"input_tokens": 1000000, "output_tokens": 500000},
            [], pricing)
        self.assertAlmostEqual(cost, 14.0)
        self.assertEqual(used["model"], "m")
        calls = [{"input_tokens": 10, "output_tokens": 5},
                 {"input_tokens": 20, "output_tokens": 5}]
        cost, _ = run_muse.compute_cost("m", None, calls, pricing)
        self.assertAlmostEqual(cost, (30 * 4 + 10 * 20) / 1000000)

    def test_compute_cost_missing_data_is_none(self):
        pricing = run_muse.parse_pricing(
            {"input_per_mtok": 1, "output_per_mtok": 1})
        self.assertEqual(run_muse.compute_cost("m", None, [],
                                                 pricing),
                         (None, None))
        partial = [{"input_tokens": 10, "output_tokens": None}]
        self.assertEqual(run_muse.compute_cost("m", None, partial,
                                                 pricing),
                         (None, None))
        unpriced = run_muse.parse_pricing(
            {"other": {"input_per_mtok": 1, "output_per_mtok": 1}})
        self.assertEqual(run_muse.compute_cost(
            "m", {"input_tokens": 5, "output_tokens": 5}, [],
            unpriced), (None, None))

    def _run_with_fake(self, fake_name, result, **kwargs):
        with tempfile.TemporaryDirectory() as td:
            old = (run_muse.RUNS, getattr(run_muse, fake_name))
            run_muse.RUNS = Path(td) / "muse-runs"
            setattr(run_muse, fake_name, lambda *a, **k: result)
            try:
                return run_muse.run_prompt("hi", **kwargs)
            finally:
                run_muse.RUNS, = old[:1]
                setattr(run_muse, fake_name, old[1])

    def test_run_prompt_computes_cost_and_keeps_reported(self):
        pricing = run_muse.parse_pricing(
            {"input_per_mtok": 1000000, "output_per_mtok": 1000000})
        base = {"session_id": None, "wall_ms": 5, "exit_code": 0,
                "timed_out": False, "interrupted": False, "reply": "x",
                "calls": [{"model": "m", "duration_ms": 5,
                           "input_tokens": 2, "output_tokens": 1,
                           "cached_tokens": None,
                           "reasoning_tokens": None}],
                "timeline": [], "command": "fake",
                "usage_model": "m", "error_override": None}
        report = self._run_with_fake(
            "run_anthropic", dict(base), provider="anthropic",
            model="m", pricing=pricing)
        self.assertAlmostEqual(report["cost_usd"], 3.0)
        self.assertEqual(report["cost_source"], "computed")
        reported = dict(base, cost_usd=9.5, totals={
            "input_tokens": 2, "output_tokens": 1,
            "cached_tokens": None}, api_ms=None, ttft_ms=None,
            num_turns=None)
        report = self._run_with_fake(
            "run_claude_code", reported, provider="claude-code",
            model="m", pricing=pricing)
        self.assertEqual(report["cost_usd"], 9.5)
        self.assertEqual(report["cost_source"], "reported")

    def test_server_session_row_carries_cost_source(self):
        base = {"run_id": "x", "at": None, "prompt": "", "model": "m",
                "wall_ms": None, "calls": [], "provider": "meta",
                "cost_usd": 1.25, "cost_source": "computed"}
        row = server.session_row(base)
        self.assertEqual(row["cost_usd"], 1.25)
        self.assertEqual(row["cost_source"], "computed")


class ManifestTest(unittest.TestCase):
    def _write(self, td, data):
        path = Path(td) / "bench.json"
        path.write_text(json.dumps(data))
        return path

    def _patched_suite(self, td, fake_run):
        old = (run_muse.run_prompt, run_muse.RUNS,
               run_muse.harness_version, run_muse.env_pricing)
        run_muse.run_prompt = fake_run
        run_muse.RUNS = Path(td) / "no-runs"
        run_muse.harness_version = lambda p: "v-now"
        run_muse.env_pricing = lambda: {}
        return old

    def _restore(self, old):
        (run_muse.run_prompt, run_muse.RUNS,
         run_muse.harness_version, run_muse.env_pricing) = old

    def test_load_manifest_settings_and_file_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "big.md").write_text("prompt from file")
            path = self._write(td, {
                "settings": {"concurrency": 2, "repeat": 1,
                             "max_cost_usd": 5,
                             "pricing": {"input_per_mtok": 1,
                                         "output_per_mtok": 2}},
                "prompts": [
                    {"name": "a", "file": "big.md", "skip": True,
                     "timeout_seconds": 60}]})
            manifest = run_muse.load_manifest(path)
        entry = manifest["entries"][0]
        self.assertEqual(entry["prompt"], "prompt from file")
        self.assertTrue(entry["skip"])
        self.assertEqual(entry["timeout_seconds"], 60)
        self.assertEqual(manifest["settings"]["concurrency"], 2)
        self.assertEqual(
            manifest["settings"]["pricing"]["*"]["output_per_mtok"],
            2.0)

    def test_load_manifest_rejects_bad_new_fields(self):
        bad = [
            {"prompts": [{"name": "a", "prompt": "p", "file": "f.md"}]},
            {"prompts": [{"name": "a", "file": "missing.md"}]},
            {"prompts": [{"name": "a", "prompt": "p", "skip": "yes"}]},
            {"prompts": [{"name": "a", "prompt": "p",
                          "timeout_seconds": 0}]},
            {"settings": {"concurrency": 99},
             "prompts": [{"name": "a", "prompt": "p"}]},
            {"settings": {"max_cost_usd": -1},
             "prompts": [{"name": "a", "prompt": "p"}]},
        ]
        with tempfile.TemporaryDirectory() as td:
            for data in bad:
                with self.assertRaises(ValueError):
                    run_muse.load_manifest(self._write(td, data))

    def test_effective_timeout_precedence(self):
        entry = {"provider": "meta", "timeout_seconds": 60}
        settings = {"timeout_seconds": 600}
        self.assertEqual(run_muse.effective_timeout(
            entry, settings, 9), 9)
        self.assertEqual(run_muse.effective_timeout(
            entry, settings, None), 60)
        self.assertEqual(run_muse.effective_timeout(
            {"provider": "meta", "timeout_seconds": None},
            settings, None), 600)
        self.assertEqual(run_muse.effective_timeout(
            {"provider": "anthropic", "timeout_seconds": None},
            {"timeout_seconds": None}, None), 300)

    def test_run_suite_honours_skip_and_entry_timeout(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write(td, {"prompts": [
                {"name": "a", "prompt": "pa", "timeout_seconds": 42},
                {"name": "b", "prompt": "pb", "skip": True}]})
            calls = []
            old = self._patched_suite(
                td, lambda p, **k: calls.append((p, k))
                or {"status": "completed", "wall_ms": 1})
            try:
                code = run_muse.run_suite(path, repeat=1)
            finally:
                self._restore(old)
        self.assertEqual(code, 0)
        self.assertEqual([c[0] for c in calls], ["pa"])
        self.assertEqual(calls[0][1]["timeout"], 42)

    def test_dry_run_runs_nothing_and_writes_no_state(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write(td, {"prompts": [
                {"name": "a", "prompt": "pa", "provider": "anthropic"}]})
            calls = []
            old = self._patched_suite(
                td, lambda p, **k: calls.append(p)
                or {"status": "completed"})
            out = io.StringIO()
            try:
                import contextlib
                with contextlib.redirect_stdout(out):
                    code = run_muse.run_suite(
                        path, repeat=1, dry_run=True, resume=True)
            finally:
                self._restore(old)
            self.assertFalse(
                run_muse.suite_state_path(path).exists())
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertIn("PAID", out.getvalue())
        self.assertIn("Dry run only", out.getvalue())

    def test_resume_skips_completed_and_keeps_suite_id(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write(td, {"prompts": [
                {"name": "a", "prompt": "pa"},
                {"name": "b", "prompt": "pb"}]})
            calls = []
            old = self._patched_suite(
                td, lambda p, **k: calls.append((p, k["suite_id"]))
                or {"status": "completed", "wall_ms": 1,
                    "run_id": "r-" + p, "cost_usd": 0.5})
            try:
                first = run_muse.run_suite(path, repeat=1, resume=True)
                second = run_muse.run_suite(path, repeat=1, resume=True)
            finally:
                self._restore(old)
            state = json.loads(
                run_muse.suite_state_path(path).read_text())
        self.assertEqual((first, second), (0, 0))
        self.assertEqual([c[0] for c in calls], ["pa", "pb"])
        self.assertEqual(state["entries"]["a#1"]["status"],
                         "completed")
        self.assertEqual(state["suite_id"], calls[0][1])

    def test_cost_budget_stops_starting_new_entries(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write(td, {
                "settings": {"max_cost_usd": 1.0},
                "prompts": [{"name": "a", "prompt": "pa"},
                            {"name": "b", "prompt": "pb"},
                            {"name": "c", "prompt": "pc"}]})
            calls = []
            old = self._patched_suite(
                td, lambda p, **k: calls.append(p)
                or {"status": "completed", "wall_ms": 1,
                    "cost_usd": 0.6})
            try:
                code = run_muse.run_suite(path, repeat=1, resume=True)
            finally:
                self._restore(old)
            state = json.loads(
                run_muse.suite_state_path(path).read_text())
        self.assertEqual(code, 1)
        self.assertEqual(calls, ["pa", "pb"])
        self.assertEqual(state["entries"]["c#1"]["status"],
                         "not_started")
        self.assertEqual(state["entries"]["c#1"]["reason"],
                         "cost budget reached")

    def test_concurrency_runs_entries_in_parallel(self):
        import time
        with tempfile.TemporaryDirectory() as td:
            path = self._write(td, {
                "settings": {"concurrency": 3},
                "prompts": [{"name": n, "prompt": "p" + n}
                            for n in "abc"]})

            def slow(prompt, **kwargs):
                time.sleep(0.25)
                return {"status": "completed", "wall_ms": 250}

            old = self._patched_suite(td, slow)
            started = time.monotonic()
            try:
                code = run_muse.run_suite(path, repeat=1)
            finally:
                self._restore(old)
            elapsed = time.monotonic() - started
        self.assertEqual(code, 0)
        self.assertLess(elapsed, 0.6)

    def test_entry_model_matches_recorded_model(self):
        self.assertEqual(run_muse._entry_model(
            {"provider": "echo", "model": None}), "echo")
        self.assertEqual(run_muse._entry_model(
            {"provider": "meta", "model": "custom-m"}), "custom-m")

    def test_suite_option_flags_need_suite(self):
        import contextlib
        for argv in (["run-muse", "--dry-run", "hi"],
                     ["run-muse", "--suite", "--fresh"]):
            err = io.StringIO()
            with mock.patch.object(sys, "argv", argv):
                with contextlib.redirect_stderr(err):
                    with self.assertRaises(SystemExit) as ctx:
                        run_muse.main()
            self.assertEqual(ctx.exception.code, 2)


class PaidNoticeTest(unittest.TestCase):
    def _run_with_ki(self, provider, model, fake_name):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs = run_muse.RUNS
            old_fn = getattr(run_muse, fake_name)
            run_muse.RUNS = runs
            setattr(run_muse, fake_name,
                    lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt()))
            out = io.StringIO()
            try:
                with mock.patch.dict(os.environ, {
                        "ANTHROPIC_API_KEY": "secret-sentinel-a",
                        "MODEL_API_KEY": "secret-sentinel-m"}):
                    with contextlib.redirect_stdout(out):
                        run_muse.run_prompt("hi", provider=provider,
                                            model=model)
            finally:
                run_muse.RUNS = old_runs
                setattr(run_muse, fake_name, old_fn)
            return out.getvalue()

    def test_notice_names_key_per_model_and_never_prints_value(self):
        out = self._run_with_ki("anthropic", "claude-x", "run_anthropic")
        self.assertIn("Paid run: uses ANTHROPIC_API_KEY", out)
        self.assertNotIn("secret-sentinel", out)
        out = self._run_with_ki("claude-code", "muse-wonder-1.0",
                                "run_claude_code")
        self.assertIn("Paid run: uses MODEL_API_KEY", out)
        self.assertNotIn("secret-sentinel", out)
        out = self._run_with_ki("claude-code", "claude-sonnet-5-5",
                                "run_claude_code")
        self.assertIn("Paid run: uses ANTHROPIC_API_KEY", out)

    def test_no_notice_for_subscription_runs(self):
        out = self._run_with_ki("meta", "muse-wonder-1.0", "run_muse_exec")
        self.assertNotIn("Paid run", out)

    def test_mode_claude_switch_prints_notice(self):
        switched = run_muse.handle_command("/mode claude",
                                           {"mode": "single"})
        self.assertEqual(switched["mode"], "claude")
        self.assertIn("Paid run: uses MODEL_API_KEY", switched["text"])
        self.assertIn("Paid run: uses ANTHROPIC_API_KEY", switched["text"])
        meta = run_muse.handle_command("/mode meta", {"mode": "single"})
        self.assertNotIn("Paid run", meta["text"])


class DefaultTimeoutTest(unittest.TestCase):
    def test_default_timeout_per_provider(self):
        self.assertEqual(run_muse.default_timeout("meta"), 1800)
        self.assertEqual(run_muse.default_timeout("echo"), 1800)
        self.assertEqual(run_muse.default_timeout("claude-code"), 300)
        self.assertEqual(run_muse.default_timeout("anthropic"), 300)

    def _captured_timeout(self, provider, model, fake_name, **kwargs):
        import contextlib
        import io
        captured = {}

        # Each fake records the timeout argument by position.
        if fake_name in ("run_anthropic", "run_claude_code"):
            def fake(prompt, run_dir, mdl, timeout, **kwargs):
                captured["timeout"] = timeout
                return _completed()
        else:
            def fake(prompt, run_dir, prov, mdl, minimal, timeout,
                     session_id=None, **kwargs):
                captured["timeout"] = timeout
                return _completed(session_id=session_id)

        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs = run_muse.RUNS
            old_fn = getattr(run_muse, fake_name)
            run_muse.RUNS = runs
            setattr(run_muse, fake_name, fake)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    report = run_muse.run_prompt(
                        "hi", provider=provider, model=model, **kwargs)
            finally:
                run_muse.RUNS = old_runs
                setattr(run_muse, fake_name, old_fn)
        return captured["timeout"], report["timeout_seconds"]

    def test_run_prompt_resolves_timeout_per_provider(self):
        self.assertEqual(
            self._captured_timeout("anthropic", "claude-x",
                                   "run_anthropic"), (300, 300))
        self.assertEqual(
            self._captured_timeout("claude-code", "claude-x",
                                   "run_claude_code"), (300, 300))
        self.assertEqual(
            self._captured_timeout("meta", "muse-wonder-1.0",
                                   "run_muse_exec"), (1800, 1800))

    def test_explicit_timeout_wins_for_all_providers(self):
        self.assertEqual(
            self._captured_timeout("anthropic", "claude-x",
                                   "run_anthropic", timeout=42), (42, 42))
        self.assertEqual(
            self._captured_timeout("claude-code", "claude-x",
                                   "run_claude_code", timeout=42), (42, 42))
        self.assertEqual(
            self._captured_timeout("meta", "muse-wonder-1.0",
                                   "run_muse_exec", timeout=42), (42, 42))


class RunProcessTest(unittest.TestCase):
    def test_wall_time_excludes_reader_join(self):
        with tempfile.TemporaryDirectory() as td:
            result = run_muse.run_process(
                ["sh", "-c", "sleep 3 & echo hi"], Path(td),
                dict(os.environ), Path(td) / "out.log", timeout=10)
            self.assertLess(result["wall_ms"], 2000)
            self.assertTrue(
                any("hi" in line for _, line in result["lines"]))

    def test_timeout_killpg_process_lookup(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(run_muse.os, "killpg",
                                   side_effect=ProcessLookupError):
                result = run_muse.run_process(
                    ["sh", "-c", "sleep 0.3"], Path(td),
                    dict(os.environ), Path(td) / "out.log", timeout=0.1)
            self.assertTrue(result["timed_out"])


class VisibilityTest(unittest.TestCase):
    """Visibility: split, live state, turns, approval stop (sanitised)."""

    def _records(self, name):
        return run_muse.muse_log.read_records(HERE / "fixtures" / name)

    def test_metadata_version_from_build_field(self):
        meta = run_muse.muse_log.session_metadata(
            self._records("session-turns.jsonl"))
        self.assertEqual(meta, {"model": "fake-model-1",
                                "provider": "fake-provider",
                                "version": "0.0.0-test"})

    def test_turn_boundaries_and_split_exclude_think_time(self):
        turns = run_muse.muse_log.split_turns(
            self._records("session-turns.jsonl"))
        self.assertEqual(len(turns), 2)
        self.assertEqual([t["prompt"] for t in turns],
                         ["fake prompt one", "fake prompt two"])
        # Turn 1: wall ends at last activity, not at the next prompt
        # 53 s later. Nested approval is not double-counted as tool.
        self.assertEqual(turns[0]["wall_ms"], 7300)
        self.assertEqual(turns[0]["split"], {
            "model_ms": 5000, "tool_ms": 1500,
            "approval_ms": 500, "muse_ms": 300})
        self.assertEqual(turns[1]["wall_ms"], 5200)
        self.assertEqual(turns[1]["split"], {
            "model_ms": 5000, "tool_ms": 0,
            "approval_ms": 0, "muse_ms": 200})
        self.assertEqual(turns[0]["version"], "0.0.0-test")

    def test_missing_pair_shows_dash_never_an_estimate(self):
        turns = run_muse.muse_log.split_turns(
            self._records("session-missing-pair.jsonl"))
        self.assertEqual(len(turns), 1)
        self.assertIsNone(turns[0]["split"]["tool_ms"])
        self.assertEqual(turns[0]["split"]["approval_ms"], 0)
        self.assertIsNone(turns[0]["split"]["muse_ms"])
        # A live (not ended) trailing turn is held back, not recorded.
        self.assertEqual(run_muse.muse_log.split_turns(
            self._records("session-approval.jsonl")), [])

    def test_live_state_from_log(self):
        log = run_muse.muse_log
        turns = self._records("session-turns.jsonl")
        self.assertEqual(log.live_state([]),
                         {"state": "idle", "tool": None})
        self.assertEqual(log.live_state(turns[:3]),
                         {"state": "model call running", "tool": None})
        self.assertEqual(log.live_state(turns[:5]),
                         {"state": "tool running", "tool": "FakeTool"})
        self.assertEqual(log.live_state(turns),
                         {"state": "ended", "tool": None})
        self.assertEqual(
            log.live_state(self._records("session-approval.jsonl")),
            {"state": "waiting for approval", "tool": "FakeTool"})

    def test_input_traces_lanes_steps_and_omitted(self):
        traces = run_muse.muse_log.input_traces(
            self._records("session-xray.jsonl"))
        self.assertEqual([t["step"] for t in traces], [0, 1])
        self.assertEqual(traces[0]["total_bytes"], 1000)
        self.assertEqual(traces[0]["user_bytes"], 10)
        self.assertEqual(traces[0]["omitted_groups"], 0)
        self.assertEqual(traces[0]["lanes"][0], {
            "lane": "system_base", "source": "fake_default",
            "wire": "option:fake.instructions", "bytes": 600,
            "lane_count": 1})
        # Zero-byte groups stay in the data. The view decides display.
        self.assertEqual(traces[0]["lanes"][3]["bytes"], 0)
        self.assertEqual(traces[1]["omitted_groups"], 1)
        self.assertEqual(traces[1]["omitted_bytes"], 50)
        self.assertEqual(traces[1]["lanes"][2]["lane_count"], 3)

    def test_input_traces_absent_means_empty_never_invented(self):
        self.assertEqual(run_muse.muse_log.input_traces(
            self._records("session-turns.jsonl")), [])
        self.assertEqual(run_muse.muse_log.input_traces([]), [])

    def test_server_xray_field_from_session_log(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-xray").mkdir(parents=True)
            sess = Path(td) / "sessions" / "fake-session-xray"
            sess.mkdir(parents=True)
            (sess / "session.jsonl").write_text(
                (HERE / "fixtures" / "session-xray.jsonl").read_text())
            run = {"run_id": "run-xray",
                   "at": datetime.now(timezone.utc).isoformat(),
                   "prompt": "fake prompt", "model": "fake-model-1",
                   "provider": "meta", "session_id": "fake-session-xray",
                   "context_mode": "full", "comparison_id": None,
                   "status": "completed", "timeout_seconds": 1800,
                   "wall_ms": 10000, "exit_code": 0, "reply": "ok",
                   "calls": [], "metrics_unavailable": False,
                   "error": None}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old_index = server.INDEX
            old_env = os.environ.get("MUSE_SESSIONS_DIR")
            server.INDEX = runs / "index.jsonl"
            server._SESSION_LOG_CACHE.clear()
            os.environ["MUSE_SESSIONS_DIR"] = str(Path(td) / "sessions")
            try:
                data = server.read_logs("run-xray")
            finally:
                server.INDEX = old_index
                server._SESSION_LOG_CACHE.clear()
                if old_env is None:
                    os.environ.pop("MUSE_SESSIONS_DIR", None)
                else:
                    os.environ["MUSE_SESSIONS_DIR"] = old_env
            self.assertEqual([t["total_bytes"] for t in data["xray"]],
                             [1000, 1250])

    def test_tool_intervals_named_nested_and_timed(self):
        out = run_muse.muse_log.tool_intervals(
            self._records("session-turns.jsonl"))
        self.assertEqual(out["unclosed_tools"], [])
        self.assertEqual(out["unclosed_approvals"], [])
        self.assertEqual(len(out["intervals"]), 2)
        tool = next(i for i in out["intervals"] if i["kind"] == "tool")
        appr = next(i for i in out["intervals"]
                    if i["kind"] == "approval")
        # Turn fixture: tool 5.3s -> 7.3s mark, approval nested
        # 5.4s -> 5.9s. Full durations stay recorded, wait separated.
        self.assertEqual(tool["name"], "FakeTool")
        self.assertEqual(tool["duration_ms"], 2000)
        self.assertEqual(tool["wait_ms"], 500)
        self.assertEqual(appr["name"], "FakeTool")
        self.assertEqual(appr["duration_ms"], 500)
        self.assertEqual(appr["wait_ms"], 0)
        self.assertLess(tool["start_at"], appr["start_at"])
        self.assertLess(appr["end_at"], tool["end_at"])

    def test_tool_intervals_unclosed_never_get_durations(self):
        out = run_muse.muse_log.tool_intervals(
            self._records("session-missing-pair.jsonl"))
        self.assertEqual(out["intervals"], [])
        self.assertEqual(out["unclosed_tools"], ["FakeTool"])
        out = run_muse.muse_log.tool_intervals(
            self._records("session-approval.jsonl"))
        self.assertEqual(out["unclosed_tools"], ["FakeTool"])
        self.assertEqual(out["unclosed_approvals"], ["FakeTool"])
        empty = {"intervals": [], "unclosed_tools": [],
                 "unclosed_approvals": []}
        self.assertEqual(run_muse.muse_log.tool_intervals([]), empty)

    def test_server_intervals_field_from_session_log(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-tools").mkdir(parents=True)
            sess = Path(td) / "sessions" / "fake-session-tools"
            sess.mkdir(parents=True)
            (sess / "session.jsonl").write_text(
                (HERE / "fixtures" / "session-turns.jsonl").read_text())
            run = {"run_id": "run-tools",
                   "at": datetime.now(timezone.utc).isoformat(),
                   "prompt": "fake prompt", "model": "fake-model-1",
                   "provider": "meta", "session_id": "fake-session-tools",
                   "context_mode": "full", "comparison_id": None,
                   "status": "completed", "timeout_seconds": 1800,
                   "wall_ms": 10000, "exit_code": 0, "reply": "ok",
                   "calls": [], "metrics_unavailable": False,
                   "error": None}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old_index = server.INDEX
            old_env = os.environ.get("MUSE_SESSIONS_DIR")
            server.INDEX = runs / "index.jsonl"
            server._SESSION_LOG_CACHE.clear()
            os.environ["MUSE_SESSIONS_DIR"] = str(Path(td) / "sessions")
            try:
                data = server.read_logs("run-tools")
            finally:
                server.INDEX = old_index
                server._SESSION_LOG_CACHE.clear()
                if old_env is None:
                    os.environ.pop("MUSE_SESSIONS_DIR", None)
                else:
                    os.environ["MUSE_SESSIONS_DIR"] = old_env
            kinds = sorted(i["kind"] for i in data["intervals"]["intervals"])
            self.assertEqual(kinds, ["approval", "tool"])

    def test_watch_callback_stops_run_at_once(self):
        with tempfile.TemporaryDirectory() as td:
            result = run_muse.run_process(
                ["sh", "-c", "sleep 5"], Path(td), dict(os.environ),
                Path(td) / "out.log", timeout=30,
                watch=lambda: ("needs_approval", "FakeTool"))
            self.assertEqual(result["needs_approval"], "FakeTool")
            self.assertLess(result["wall_ms"], 4000)

    def test_exec_uses_approval_mode_never(self):
        captured = {}

        def fake_process(cmd, cwd, env, out, timeout, input_text=None,
                         watch=None, stop_event=None):
            captured["cmd"] = cmd
            Path(out).write_text("")
            return {"wall_ms": 1, "exit_code": 1, "timed_out": False,
                    "interrupted": False, "lines": [],
                    "needs_approval": "FakeTool"}

        with tempfile.TemporaryDirectory() as td:
            old = run_muse.run_process
            run_muse.run_process = fake_process
            try:
                result = run_muse.run_muse_exec(
                    "hi", Path(td), "meta", "fake-model", False, 30,
                    session_id="fake-session")
            finally:
                run_muse.run_process = old
        self.assertIn("--approval-mode", captured["cmd"])
        self.assertIn("never", captured["cmd"])
        self.assertEqual(result["needs_approval"], "FakeTool")

    def test_run_records_needs_approval_status(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs, old_fn = run_muse.RUNS, run_muse.run_muse_exec
            run_muse.RUNS = runs
            run_muse.run_muse_exec = lambda *a, **k: _completed(
                needs_approval="FakeTool")
            try:
                report = run_muse.run_prompt(
                    "hi", provider="meta", model="fake-model")
            finally:
                run_muse.RUNS, run_muse.run_muse_exec = old_runs, old_fn
            self.assertEqual(report["status"], "needs_approval")
            self.assertEqual(report["needs_approval_tool"], "FakeTool")
            self.assertIn("waiting for approval: FakeTool",
                          report["error"])

    def test_retry_parsing_and_no_retry_case(self):
        log = run_muse.muse_log
        calls = log.calls_from_records(self._records("session-retry.jsonl"))
        self.assertEqual(len(calls), 2)
        # Model time stays Muse's duration; the stall sits inside it.
        self.assertEqual(calls[0]["duration_ms"], 11000)
        self.assertEqual(calls[0]["retries"], 1)
        self.assertEqual(calls[0]["stalled_ms"], 5000)
        # A call with no retry carries no retry data at all.
        self.assertEqual(calls[1]["retries"], 0)
        self.assertIsNone(calls[1]["stalled_ms"])
        clean = log.calls_from_records(self._records("session-turns.jsonl"))
        self.assertTrue(all(c["retries"] == 0 and c["stalled_ms"] is None
                            for c in clean))
        # Live: mid-retry reads as retrying, not model running.
        recs = self._records("session-retry.jsonl")
        self.assertEqual(log.live_state(recs[:4]), {
            "state": "retrying connection", "tool": None,
            "attempt": "2/10"})
        self.assertEqual(
            run_muse.format_live_line(log.live_state(recs[:4])),
            "retrying connection (attempt 2/10)")

    def test_two_nodes_in_one_record_align_retries_by_record(self):
        log = run_muse.muse_log

        def status(at, message):
            return {"recorded_at": at * 1000,
                    "payload": {"event": {"kind": "status",
                                          "message": message}}}

        def node(duration, input_tokens):
            return {"kind": "model_completed", "duration_ms": duration,
                    "usage": {"input_tokens": input_tokens,
                              "output_tokens": 1, "cached_tokens": 0,
                              "reasoning_tokens": 0}}

        records = [
            {"payload": {"event": {"kind": "model_request_configured"}}},
            status(2000, "opening meta model stream attempt 1/10"),
            status(3000, "retrying meta model stream in 1000ms "
                         "(attempt 2/10)"),
            status(8000, "opening meta model stream attempt 2/10"),
            {"payload": {"event": {"kind": "model_completed"},
                         "nodes": [node(100, 10), node(200, 20)]}},
            {"payload": {"event": {"kind": "model_request_configured"}}},
            {"payload": {"event": {"kind": "model_completed"},
                         "nodes": [node(300, 30)]}},
        ]
        calls = log.calls_from_records(records)
        self.assertEqual(len(calls), 3)
        # The retry belongs to the record that carried it: the first
        # node gets it, the second node in the same record does not,
        # and the next call is not shifted onto it.
        self.assertEqual(calls[0]["retries"], 1)
        self.assertEqual(calls[0]["stalled_ms"], 5000)
        self.assertEqual(calls[1]["retries"], 0)
        self.assertIsNone(calls[1]["stalled_ms"])
        self.assertEqual(calls[2]["retries"], 0)
        self.assertIsNone(calls[2]["stalled_ms"])
        self.assertEqual(log.retry_infos(records),
                         [{"retries": 1, "stalled_ms": 5000},
                          {"retries": 0, "stalled_ms": None},
                          {"retries": 0, "stalled_ms": None}])

    def test_live_calls_carry_retry_fields(self):
        log = run_muse.muse_log
        calls, timeline = log.live_calls_from_records(
            self._records("session-retry.jsonl"))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["retries"], 1)
        self.assertEqual(calls[0]["stalled_ms"], 5000)
        self.assertEqual(calls[1]["retries"], 0)
        self.assertIsNone(calls[1]["stalled_ms"])
        self.assertTrue(timeline)

    def test_live_lines_format(self):
        self.assertEqual(
            run_muse.format_call_line(
                7, {"duration_ms": 12400, "input_tokens": 41000}),
            "call 7 · 12.4 s · 41k in")
        self.assertEqual(
            run_muse.format_call_line(
                1, {"duration_ms": 188600, "input_tokens": 29000,
                    "retries": 1, "stalled_ms": 181000}),
            "call 1 · 188.6 s (181 s stalled, 1 retry) · 29k in")
        self.assertEqual(
            run_muse.format_call_line(
                2, {"duration_ms": 3000, "input_tokens": 1000,
                    "retries": 0, "stalled_ms": None}),
            "call 2 · 3.0 s · 1k in")
        self.assertEqual(
            run_muse.format_live_line(
                {"state": "waiting for approval", "tool": "FakeTool"}),
            "waiting for approval: FakeTool")
        self.assertEqual(
            run_muse.format_live_line(
                {"state": "tool running", "tool": "FakeTool"}),
            "tool running: FakeTool")

    def test_server_live_state_and_split_for_running_run(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-live").mkdir(parents=True)
            sess = Path(td) / "sessions" / "fake-session-1"
            sess.mkdir(parents=True)
            (sess / "session.jsonl").write_text(
                (HERE / "fixtures" / "session-approval.jsonl")
                .read_text())
            run = {"run_id": "run-live",
                   "at": datetime.now(timezone.utc).isoformat(),
                   "prompt": "fake prompt", "model": "fake-model-1",
                   "provider": "meta", "session_id": "fake-session-1",
                   "context_mode": "full", "comparison_id": None,
                   "status": "running", "timeout_seconds": 1800,
                   "wall_ms": None, "exit_code": None, "reply": "",
                   "calls": [], "metrics_unavailable": False,
                   "error": None}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old_index = server.INDEX
            old_env = os.environ.get("MUSE_SESSIONS_DIR")
            server.INDEX = runs / "index.jsonl"
            server._SESSION_LOG_CACHE.clear()
            os.environ["MUSE_SESSIONS_DIR"] = str(Path(td) / "sessions")
            try:
                data = server.read_logs("run-live")
            finally:
                server.INDEX = old_index
                server._SESSION_LOG_CACHE.clear()
                if old_env is None:
                    os.environ.pop("MUSE_SESSIONS_DIR", None)
                else:
                    os.environ["MUSE_SESSIONS_DIR"] = old_env
            self.assertEqual(data["live_state"], {
                "state": "waiting for approval", "tool": "FakeTool"})
            self.assertIsNone(data["time_split"]["approval_ms"])
            self.assertIsNone(data["time_split"]["muse_ms"])


class RetroTest(unittest.TestCase):
    """Ambient retro: backfill closed turns from logs already on disk."""

    def _setup(self, td, sessions, index_lines=()):
        runs = Path(td) / "muse-runs"
        runs.mkdir(parents=True)
        if index_lines:
            (runs / "index.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in index_lines))
        sess_root = Path(td) / "sessions"
        for sid, spec in sessions.items():
            name, offset = spec if isinstance(spec, tuple) else (spec, 0)
            lines = []
            for line in (HERE / "fixtures" / name).read_text().splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if offset and rec.get("recorded_at"):
                    rec["recorded_at"] += offset
                lines.append(json.dumps(rec))
            log = sess_root / sid / "session.jsonl"
            log.parent.mkdir(parents=True)
            log.write_text("\n".join(lines) + "\n")
        return runs, sess_root

    def _run_retro(self, runs, sess_root):
        import contextlib
        old_runs = run_muse.RUNS
        old = os.environ.get("MUSE_SESSIONS_DIR")
        run_muse.RUNS = runs
        os.environ["MUSE_SESSIONS_DIR"] = str(sess_root)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                run_muse.run_retro()
        finally:
            run_muse.RUNS = old_runs
            if old is None:
                os.environ.pop("MUSE_SESSIONS_DIR", None)
            else:
                os.environ["MUSE_SESSIONS_DIR"] = old

    def _index(self, runs):
        path = runs / "index.jsonl"
        if not path.is_file():
            return []
        return [json.loads(l) for l in path.read_text().splitlines()
                if l.strip()]

    def test_retro_imports_closed_turns_as_runs(self):
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {"fake-1": "session-turns.jsonl"})
            self._run_retro(runs, sess)
            entries = self._index(runs)
            self.assertEqual(len(entries), 2)
            self.assertEqual([e["turn_index"] for e in entries], [1, 2])
            self.assertEqual([e["prompt"] for e in entries],
                             ["fake prompt one", "fake prompt two"])
            for e in entries:
                self.assertEqual(e["provider"], "muse-retro")
                self.assertEqual(e["command"], "./run-muse --retro")
                self.assertEqual(e["context_mode"], "interactive")
                self.assertEqual(e["session_id"], "fake-1")
                self.assertEqual(e["harness_version"], "0.0.0-test")
                self.assertEqual(e["status"], "completed")
            report = json.loads((runs / entries[0]["run_id"]
                                 / "report.json").read_text())
            self.assertTrue(report["timeline"])
            self.assertTrue(all(t.get("at") for t in report["timeline"]))
            self.assertNotIn("timeline", entries[0])
            self.assertEqual(entries[0]["wall_ms"], 7300)
            self.assertEqual(entries[0]["tool_ms"], 1500)
            self.assertEqual(entries[0]["approval_ms"], 500)
            self.assertEqual(entries[0]["muse_ms"], 300)

    def test_retro_rerun_imports_nothing_new(self):
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {"fake-1": "session-turns.jsonl"})
            self._run_retro(runs, sess)
            self._run_retro(runs, sess)
            self.assertEqual(len(self._index(runs)), 2)

    def test_retro_skips_launcher_owned_session_whole(self):
        owned = {"run_id": "run-owned", "provider": "meta",
                 "session_id": "fake-1", "status": "completed"}
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {"fake-1": "session-turns.jsonl"},
                                     index_lines=[owned])
            self._run_retro(runs, sess)
            self.assertEqual(self._index(runs), [owned])

    def test_retro_skips_only_the_watched_turn(self):
        watched = {"run_id": "run-watched", "provider": "muse-watch",
                   "session_id": "fake-1", "turn_index": 1,
                   "status": "completed"}
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {"fake-1": "session-turns.jsonl"},
                                     index_lines=[watched])
            self._run_retro(runs, sess)
            entries = self._index(runs)
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[1]["provider"], "muse-retro")
            self.assertEqual(entries[1]["turn_index"], 2)

    def test_retro_holds_back_open_and_turnless_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {
                "fake-open": "session-approval.jsonl",
                "fake-no-intent": "claude-code-stream.jsonl",
            })
            self._run_retro(runs, sess)
            self.assertEqual(self._index(runs), [])

    def test_retro_imports_oldest_session_first(self):
        with tempfile.TemporaryDirectory() as td:
            runs, sess = self._setup(td, {
                "a-newer": ("session-turns.jsonl", 10_000_000_000),
                "z-older": "session-turns.jsonl",
            })
            self._run_retro(runs, sess)
            self.assertEqual(
                [e["session_id"] for e in self._index(runs)],
                ["z-older", "z-older", "a-newer", "a-newer"])

    def _main_error(self, argv):
        import contextlib
        err = io.StringIO()
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    run_muse.main()
        self.assertEqual(ctx.exception.code, 2)
        return err.getvalue()

    def test_retro_takes_no_prompt_compare_or_suite(self):
        err = self._main_error(["run-muse", "--retro", "hi"])
        self.assertIn("--retro takes no prompt", err)
        err = self._main_error(
            ["run-muse", "--retro", "--compare", "meta", "hi"])
        self.assertIn("--retro takes no prompt", err)
        err = self._main_error(["run-muse", "--suite", "--retro"])
        self.assertIn("--suite takes no prompt", err)


class HarnessVersionTest(unittest.TestCase):
    def setUp(self):
        run_muse._harness_version_cache.clear()

    def tearDown(self):
        run_muse._harness_version_cache.clear()

    def _fake_run(self, stdout, returncode=0):
        def fake(cmd, capture_output=True, text=True, timeout=None):
            fake.calls.append(list(cmd))
            result = mock.Mock()
            result.stdout = stdout
            result.stderr = ""
            result.returncode = returncode
            return result
        fake.calls = []
        return fake

    def test_muse_and_claude_versions_read_once_per_process(self):
        fake = self._fake_run("Muse Code 1.4.13 (1.4.13-R6996.1)\n")
        with mock.patch.object(run_muse.subprocess, "run", fake):
            self.assertEqual(run_muse.harness_version("meta"),
                             "Muse Code 1.4.13 (1.4.13-R6996.1)")
            self.assertEqual(run_muse.harness_version("meta"),
                             "Muse Code 1.4.13 (1.4.13-R6996.1)")
        self.assertEqual(fake.calls, [["muse", "--version"]])
        run_muse._harness_version_cache.clear()
        fake2 = self._fake_run("2.1.310 (Claude Code)\n")
        with mock.patch.object(run_muse.subprocess, "run", fake2):
            self.assertEqual(run_muse.harness_version("claude-code"),
                             "2.1.310 (Claude Code)")
            self.assertEqual(run_muse.harness_version("claude-code"),
                             "2.1.310 (Claude Code)")
        self.assertEqual(fake2.calls, [["claude", "--version"]])

    def test_raw_api_stores_null_without_calling_a_command(self):
        fake = self._fake_run("should not be used")
        with mock.patch.object(run_muse.subprocess, "run", fake):
            self.assertIsNone(run_muse.harness_version("anthropic"))
        self.assertEqual(fake.calls, [])

    def test_failed_version_command_stores_null_and_never_raises(self):
        fake = self._fake_run("", returncode=1)
        with mock.patch.object(run_muse.subprocess, "run", fake):
            self.assertIsNone(run_muse.harness_version("meta"))
        run_muse._harness_version_cache.clear()
        with mock.patch.object(run_muse.subprocess, "run",
                               side_effect=OSError("missing binary")):
            self.assertIsNone(run_muse.harness_version("meta"))
        run_muse._harness_version_cache.clear()
        with mock.patch.object(run_muse.subprocess, "run",
                               side_effect=Exception("boom")):
            self.assertIsNone(run_muse.harness_version("claude-code"))

    def test_run_records_harness_version_and_server_passes_it(self):
        fake = self._fake_run("Muse Code 9.9.9\n")
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            old_runs, old_fn = run_muse.RUNS, run_muse.run_muse_exec
            run_muse.RUNS = runs
            run_muse.run_muse_exec = lambda *a, **k: \
                (_ for _ in ()).throw(KeyboardInterrupt())
            try:
                with mock.patch.object(run_muse.subprocess, "run", fake):
                    report = run_muse.run_prompt(
                        "hi", provider="meta", model="muse-wonder-1.0")
            finally:
                run_muse.RUNS, run_muse.run_muse_exec = old_runs, old_fn
            self.assertEqual(report["harness_version"], "Muse Code 9.9.9")
            entries = [json.loads(l) for l in
                       (runs / "index.jsonl").read_text().splitlines()]
            by_id = {e["run_id"]: e for e in entries}
            self.assertEqual(by_id[report["run_id"]]["harness_version"],
                             "Muse Code 9.9.9")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs(report["run_id"])
            finally:
                server.INDEX = old
            picked = next(s for s in data["sessions"]
                          if s["run_id"] == report["run_id"])
            self.assertEqual(picked["harness_version"], "Muse Code 9.9.9")
            self.assertEqual(data["harness_version"], "Muse Code 9.9.9")

    def test_old_runs_without_version_read_as_null(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            (runs / "run-old").mkdir(parents=True)
            run = {"run_id": "run-old", "at": "2026-01-01T00:00:00+00:00",
                   "prompt": "hi", "model": "m", "provider": "meta",
                   "exit_code": 0, "error": None, "reply": "ok",
                   "wall_ms": 100, "calls": []}
            (runs / "index.jsonl").write_text(json.dumps(run) + "\n")
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                data = server.read_logs()
            finally:
                server.INDEX = old
            self.assertIsNone(data["sessions"][0]["harness_version"])
            self.assertIsNone(data["harness_version"])


class IndexHtmlTest(unittest.TestCase):
    """Static contract for the React results page (web/ shell + src)."""

    @classmethod
    def setUpClass(cls):
        here = Path(__file__).parent
        cls.html = (here / "web" / "index.html").read_text()
        src = here / "frontend" / "src"
        cls.src = "\n".join(
            p.read_text() for p in sorted(src.rglob("*.jsx"))) + "\n" + \
            "\n".join(p.read_text() for p in sorted(src.rglob("*.js")))

    def test_shell_loads_bundle_and_styles(self):
        self.assertIn('id="root"', self.html)
        self.assertIn("/app.js", self.html)
        self.assertIn("/style.css", self.html)

    def test_three_way_compare_hooks_present(self):
        # One prompt run 3 ways (a comparison set) gets a median table plus
        # a round-by-leg matrix; manual compare takes two extra sessions.
        # Dashboard shell: URL routes own the selected run, sidebar links
        # follow the URL, the TanStack runs table, recent-runs chart,
        # medians panel.
        for marker in ("compareSelect2", "CompareSet", "PerCallChart",
                       "RecentRunsChart", "Medians by provider/model",
                       "data-view-panel", "BrowserRouter", "/runs/:id",
                       "Run not found", "runsTable",
                       "RUNS_PAGE_SIZE", "filterSessions", "compareSessions"):
            self.assertIn(marker, self.src)
        self.assertNotIn("useLegacyTable", self.src)
        self.assertNotIn("@tanstack/react-table", self.src)
        self.assertNotIn("<CallChart", self.src)
        self.assertNotIn("function CallChart", self.src)
        self.assertNotIn("useTable", self.src)

    def test_part_e_diagnose_hooks_present(self):
        # Selected-run chip removed from the top bar; filter chips stay.
        self.assertNotIn('className="runChip"', self.src)
        self.assertNotIn("chipX", self.src)
        self.assertIn("filterChips", self.src)
        for marker in ("What happened", "PerCallChart",
                       "explainLines", "usualBaseline", "perCallSeries",
                       "harness_version", "versionFilter",
                       "Claude Code doesn't report per-call time"):
            self.assertIn(marker, self.src)

    def test_part_f_visibility_hooks_present(self):
        for marker in ("liveBanner", "liveStateText", "time_split",
                       "Approval wait", "needs_approval",
                       "Waited ", "Tools ran for ",
                       "stalled before retry", "Retrying connection",
                       "swStalled"):
            self.assertIn(marker, self.src)

    def test_missing_values_never_become_zero(self):
        # A missing metric must render as –, never as 0 in a delta.
        self.assertNotIn("?? 0) - (", self.src)
        self.assertIn("medians over completed runs only", self.src)


class DefaultSelectionTest(unittest.TestCase):
    def _selected(self, entries):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td) / "muse-runs"
            runs.mkdir()
            (runs / "index.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in entries))
            old = server.INDEX
            server.INDEX = runs / "index.jsonl"
            try:
                return server.read_logs()["selected"]
            finally:
                server.INDEX = old

    def test_run_in_progress_is_selected_so_it_can_be_watched(self):
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        done = {"run_id": "done", "status": "completed", "at": now}
        live = {"run_id": "live", "status": "running", "at": now,
                "timeout_seconds": 1800}
        self.assertEqual(self._selected([done, live]), "live")

    def test_stale_running_run_does_not_take_over(self):
        done = {"run_id": "done", "status": "completed",
                "at": "2020-01-02T00:00:00+00:00"}
        stale = {"run_id": "stale", "status": "running",
                 "at": "2020-01-03T00:00:00+00:00", "timeout_seconds": 60}
        self.assertEqual(self._selected([done, stale]), "done")


if __name__ == "__main__":
    unittest.main(verbosity=2)
