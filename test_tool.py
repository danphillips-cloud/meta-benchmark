#!/usr/bin/env python3
"""Fixture tests for the meta-benchmark tool. Stdlib only.

Run: python3 test_tool.py
Covers run-muse's session-log harvest and timeline, the UI server's
run selection, timeline loading, error scoping, and overhead clamp,
the local-host check, stale running runs, Ctrl+C handling, the
per-provider default model, Anthropic response parsing, and the
delete guard for running runs.
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent


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
                              "ANTHROPIC_MODEL": "claude-sentinel"}):
            self.assertEqual(run_muse.default_model("meta"), "meta-sentinel")
            self.assertEqual(run_muse.default_model("anthropic"),
                             "claude-sentinel")
            self.assertEqual(
                run_muse.parse_compare_models(
                    "meta, anthropic, meta:custom-meta, anthropic:custom-claude"),
                [("meta", "meta-sentinel"), ("anthropic", "claude-sentinel"),
                 ("meta", "custom-meta"), ("anthropic", "custom-claude")])


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
