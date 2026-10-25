#!/usr/bin/env python3
"""Read-only meta-benchmark log viewer. Stdlib only.

Prompts happen in one terminal via ./run-muse, which drives `muse exec`
and appends each run to muse-runs/index.jsonl. This server only reads
that file and serves it to the UI. No API key is used here.
"""
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import muse_log  # noqa: E402

HERE = Path(__file__).parent
PORT = int(os.environ.get("PORT", "8765"))
VERSION = 28
INDEX = HERE / "muse-runs" / "index.jsonl"
WEB_INDEX = HERE / "web" / "index.html"
WEB_APP = HERE / "web" / "app.js"
WEB_CSS = HERE / "web" / "style.css"
_SESSION_LOG_CACHE = {}


def live_session_log(session_id):
    if not session_id:
        return None
    if session_id in _SESSION_LOG_CACHE:
        return _SESSION_LOG_CACHE[session_id]
    path = muse_log.session_log_path(session_id)
    if not path:
        return None
    _SESSION_LOG_CACHE[session_id] = path
    return path


def live_calls(session_id):
    path = live_session_log(session_id)
    if not path:
        return [], []
    return muse_log.live_calls_from_log(path)


def _is_stale_running(run):
    """A 'running' run with no final report, past its timeout + grace."""
    try:
        started = datetime.fromisoformat(run.get("at"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - started).total_seconds()
    except Exception:
        return False
    return age > (run.get("timeout_seconds") or 1800) + 300


def discover_running(runs):
    """Runs started by an older launcher: folder + prompt, no index entry."""
    indexed = {r.get("run_id") for r in runs}
    found = []
    if not INDEX.parent.is_dir():
        return found
    for d in sorted(INDEX.parent.iterdir()):
        if not d.is_dir() or d.name in indexed:
            continue
        prompt_file = d / "prompt.md"
        events_file = d / "events.jsonl"
        if not prompt_file.is_file() or not events_file.is_file():
            continue
        session_id = None
        for line in events_file.read_text(errors="replace").splitlines()[:200]:
            try:
                e = json.loads(line)
            except Exception:
                continue
            stream = e.get("stream") or {}
            if stream.get("kind") == "session":
                session_id = stream.get("id")
                break
        at = datetime.fromtimestamp(d.stat().st_mtime, timezone.utc).isoformat()
        found.append({
            "run_id": d.name,
            "at": at,
            "prompt": prompt_file.read_text(errors="replace").strip(),
            "model": None, "provider": "meta", "session_id": session_id,
            "context_mode": "full", "comparison_id": None,
            "status": "interrupted" if _is_stale_running({"at": at}) else "running",
            "wall_ms": None, "exit_code": None,
            "reply": "", "calls": [], "metrics_unavailable": False,
            "error": None})
    return found


def _run_model_ms(run):
    """Sum of per-call durations, or the harness-reported API total
    when calls carry none (Claude Code reports no per-call time)."""
    durations = [c.get("duration_ms") for c in (run.get("calls") or [])
                 if c.get("duration_ms") is not None]
    if durations:
        return sum(durations)
    return run.get("api_ms") or 0


def _run_split(run):
    """Stored time split, or one computed from the session log.

    Buckets with a missing event pair stay None (shown as –), never
    estimated. Only Muse sessions have the underlying events.
    """
    if run.get("tool_ms") is not None or run.get("approval_ms") is not None \
            or run.get("muse_ms") is not None:
        return {"model_ms": _run_model_ms(run),
                "tool_ms": run.get("tool_ms"),
                "approval_ms": run.get("approval_ms"),
                "muse_ms": run.get("muse_ms")}
    if not run.get("session_id"):
        return {"model_ms": _run_model_ms(run), "tool_ms": None,
                "approval_ms": None, "muse_ms": None}
    path = live_session_log(run["session_id"])
    if not path:
        return {"model_ms": _run_model_ms(run), "tool_ms": None,
                "approval_ms": None, "muse_ms": None}
    records = muse_log.read_records(path)
    wall = run.get("wall_ms")
    return muse_log.time_split(records, wall, _run_model_ms(run))


def _run_tokens(run, key):
    """Run token total from totals when present, else summed calls."""
    totals = run.get("totals")
    if totals:
        return totals.get(key)
    return sum(c.get(key) or 0 for c in (run.get("calls") or []))


def read_logs(run_id=None):
    runs = []
    if INDEX.is_file():
        for line in INDEX.read_text(errors="replace").splitlines():
            try:
                runs.append(json.loads(line))
            except Exception:
                continue
    # Keep the last entry per run_id: runs register as "running" first
    # and append their final summary when they finish.
    deduped = {}
    for r in runs:
        deduped[r.get("run_id")] = r
    runs = list(deduped.values())
    # A run still marked "running" with no report, long past its timeout,
    # was interrupted (e.g. Ctrl+C outside the wait) and never finished.
    fixed = []
    for r in runs:
        report_file = INDEX.parent / str(r.get("run_id")) / "report.json"
        if r.get("status") == "running" and not report_file.is_file() \
                and _is_stale_running(r):
            r = dict(r)
            r["status"] = "interrupted"
        fixed.append(r)
    runs = fixed
    runs.extend(discover_running(runs))
    # Grouped rows should agree with the live stats for running runs.
    enriched = []
    for r in runs:
        if r.get("status") == "running" and r.get("session_id"):
            live, _ = live_calls(r["session_id"])
            if live:
                r = dict(r)
                r["calls"] = live
        enriched.append(r)
    runs = enriched
    sessions = [{
        "run_id": r.get("run_id"), "at": r.get("at"),
        "prompt": r.get("prompt"), "model": r.get("model"),
        "wall_ms": r.get("wall_ms"), "calls": len(r.get("calls") or []),
        "provider": r.get("provider"), "context_mode": r.get("context_mode"),
        "comparison_id": r.get("comparison_id"), "round": r.get("round"),
        "compare_mode": r.get("compare_mode"),
        "harness_version": r.get("harness_version"),
        "cost_usd": r.get("cost_usd"),
        "ttft_ms": r.get("ttft_ms"), "status": r.get("status"),
        "model_ms": _run_model_ms(r),
        "overhead_ms": max(0, (r.get("wall_ms") or 0) - _run_model_ms(r)),
        "input_tokens": _run_tokens(r, "input_tokens"),
        "output_tokens": _run_tokens(r, "output_tokens"),
        "tool_ms": r.get("tool_ms"), "approval_ms": r.get("approval_ms"),
        "muse_ms": r.get("muse_ms"),
        "last_input_tokens": (r.get("calls") or [{}])[-1].get("input_tokens"),
        "last_output_tokens": (r.get("calls") or [{}])[-1].get("output_tokens"),
    } for r in reversed(runs)]
    # With no explicit pick, follow a run in progress so it can be
    # watched live. Otherwise open on the newest completed run, not a
    # failed or interrupted one. Stale "running" entries were already
    # marked interrupted above, so they can't take over.
    selected = next((r for r in runs if r.get("run_id") == run_id), None) \
        or next((r for r in reversed(runs) if r.get("status") == "running"),
                None) \
        or next((r for r in reversed(runs) if r.get("status") == "completed"),
                None) \
        or (runs[-1] if runs else {})
    live_timeline = []
    if selected.get("status") == "running" and selected.get("session_id"):
        live, live_timeline = live_calls(selected["session_id"])
        if live:
            selected = dict(selected)
            selected["calls"] = live
    elapsed_ms = None
    if selected.get("status") == "running" and selected.get("at"):
        try:
            started = datetime.fromisoformat(selected["at"])
            elapsed_ms = round((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        except Exception:
            elapsed_ms = None
    events, errors = [], []
    for call in selected.get("calls") or []:
        events.append({
            "prompt": selected.get("prompt"),
            "reply": selected.get("reply"),
            "model": call.get("model") or selected.get("model"),
            "wire_ms": call.get("duration_ms"),
            "gen_ai.usage.input_tokens": call.get("input_tokens"),
            "gen_ai.usage.output_tokens": call.get("output_tokens"),
            "gen_ai.usage.cached_tokens": call.get("cached_tokens"),
            "gen_ai.usage.reasoning_tokens": call.get("reasoning_tokens"),
            "retries": call.get("retries") or 0,
            "stalled_ms": call.get("stalled_ms"),
            "operation": "model call",
            "ok": selected.get("exit_code") == 0,
        })
    # Retry data lives in the session log, not in old run summaries:
    # merge it per call (call order) whenever the log is available.
    if selected.get("session_id"):
        _log = live_session_log(selected["session_id"])
        if _log:
            _infos = muse_log.retry_infos(muse_log.read_records(_log))
            for _i, _info in enumerate(_infos):
                if _i < len(events):
                    events[_i]["retries"] = _info["retries"]
                    events[_i]["stalled_ms"] = _info["stalled_ms"]
    events.reverse()
    if selected.get("error") or selected.get("exit_code") not in (0, None):
        errors.append({"at": selected.get("at"), "operation": selected.get("run_id"),
                       "error_type": selected.get("error") or f"exit {selected.get('exit_code')}"})
    # The index holds summaries only. The full timeline lives in the
    # selected run's own report.json and is loaded on demand.
    full = {}
    report_file = INDEX.parent / str(selected.get("run_id")) / "report.json"
    if selected.get("run_id") and report_file.is_file():
        try:
            full = json.loads(report_file.read_text(errors="replace"))
        except Exception:
            full = {}
    timeline = [{
        "at": t.get("at") or selected.get("at"),
        "operation": t.get("operation"),
        "duration_ms": t.get("duration_ms"),
        "wire_ms": t.get("wire_ms"),
        "ok": True,
        "error_type": None,
    } for t in (full.get("timeline") or live_timeline)]
    if selected.get("metrics_unavailable"):
        errors.append({"at": selected.get("at"),
                       "operation": selected.get("run_id"),
                       "error_type": "model metrics unavailable for this run"})
    live_state = None
    if selected.get("status") == "running" and selected.get("session_id"):
        log_path = live_session_log(selected["session_id"])
        if log_path:
            live_state = muse_log.live_state_from_log(log_path)
    return {
        "version": VERSION,
        "sessions": sessions,
        "selected": selected.get("run_id"),
        "file": (f"{len(runs)} run(s), showing {selected.get('run_id')}"
                 f" · {len(selected.get('calls') or [])} call(s)") if runs else None,
        "model": (events[0]["model"] if events else selected.get("model")),
        "prompt": selected.get("prompt"),
        "reply": selected.get("reply"),
        "provider": selected.get("provider"),
        "harness_version": selected.get("harness_version"),
        "model_ms": _run_model_ms(selected),
        "wall_ms": selected.get("wall_ms") or elapsed_ms,
        "status": selected.get("status"),
        "elapsed_ms": elapsed_ms,
        "live_state": live_state,
        "time_split": _run_split(
            dict(selected, wall_ms=selected.get("wall_ms") or elapsed_ms)),
        "events": events, "timeline": timeline, "errors": errors[-3:],
    }


def delete_run(run_id):
    if not run_id or not re.fullmatch(r"[0-9A-Za-z-]+", run_id):
        return False, "invalid run id"
    root = INDEX.parent.resolve()
    target = (root / run_id)
    if target.parent != root:
        return False, "invalid run id"
    latest = None
    kept = []
    if INDEX.is_file():
        for line in INDEX.read_text(errors="replace").splitlines():
            try:
                entry = json.loads(line)
            except Exception:
                kept.append(line)
                continue
            if entry.get("run_id") == run_id:
                latest = entry
            else:
                kept.append(line)
    if latest and latest.get("status") == "running" \
            and not (target / "report.json").is_file() \
            and not _is_stale_running(latest):
        return False, f"run {run_id} is still running"
    if INDEX.is_file():
        INDEX.write_text("".join(l + "\n" for l in kept))
    if target.is_dir():
        shutil.rmtree(target)
    return True, None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _is_local_request(self):
        host = self.headers.get("Host") or ""
        if host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://127.0.0.1:{PORT}",
                                     f"http://localhost:{PORT}"):
            return False
        return True

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, ctype):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self._send(200, body, ctype)

    def do_GET(self):
        if not self._is_local_request():
            self.send_error(403)
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/logs":
            run_id = (parse_qs(parsed.query).get("run") or [None])[0]
            self._send(200, json.dumps(read_logs(run_id)).encode(),
                       "application/json")
        elif parsed.path == "/app.js":
            self._send_file(WEB_APP, "text/javascript; charset=utf-8")
        elif parsed.path == "/style.css":
            self._send_file(WEB_CSS, "text/css; charset=utf-8")
        elif parsed.path.startswith("/api/"):
            self.send_error(404)
        else:
            # /, /index.html, and every deep link (e.g. /runs/<id>) load
            # the app shell; the client router picks the view.
            self._send_file(WEB_INDEX, "text/html; charset=utf-8")

    def do_POST(self):
        if not self._is_local_request():
            self.send_error(403)
            return
        if urlparse(self.path).path != "/api/delete":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            data = {}
        ok, reason = delete_run(str(data.get("run_id") or ""))
        body = json.dumps({"ok": ok, "reason": reason}).encode()
        self._send(200 if ok else 400, body, "application/json")


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
