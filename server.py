#!/usr/bin/env python3
"""Meta-benchmark log viewer. Stdlib only.

Prompts happen in one terminal via ./run-muse, which drives `muse exec`
and appends each run to muse-runs/index.jsonl. This server reads that
file and serves it to the UI. It writes run data only to delete runs
the user asks to delete. No API key is used here.
"""
import contextlib
import fcntl
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import claude_stream  # noqa: E402
import muse_log  # noqa: E402

HERE = Path(__file__).parent
PORT = int(os.environ.get("PORT", "8765"))
VERSION = 51
INDEX = HERE / "muse-runs" / "index.jsonl"
WEB_INDEX = HERE / "web" / "index.html"
WEB_APP = HERE / "web" / "app.js"
WEB_CSS = HERE / "web" / "style.css"
_SESSION_LOG_CACHE = {}
_LOG_RECORDS_CACHE = {}


@contextlib.contextmanager
def _index_file_lock(index_path):
    """Exclusive cross-process lock for index.jsonl writers.

    run-muse appends to the index while this server can rewrite it
    for a delete. Every writer holds this flock on a file beside the
    index, so an append can never land between a delete's read and
    its rewrite and be lost. Platforms: macOS, Linux and Windows
    via WSL. fcntl works under WSL. Native Windows Python is not
    supported. The lock file is never deleted. The OS releases the
    lock when its holder exits.
    """
    index_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = index_path.parent / (index_path.name + ".lock")
    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def live_session_log(session_id):
    if not session_id:
        return None
    cached = _SESSION_LOG_CACHE.get(session_id)
    if cached is not None:
        if Path(cached).is_file():
            return cached
        # Stale entry. The log is gone, so drop it and resolve
        # again below instead of erroring every poll.
        del _SESSION_LOG_CACHE[session_id]
        _LOG_RECORDS_CACHE.pop(str(cached), None)
    path = muse_log.session_log_path(session_id)
    if not path:
        return None
    _SESSION_LOG_CACHE[session_id] = path
    return path


def _log_records(path):
    """Parsed session log records, cached against the file stamp.

    One poll used to parse the selected running log up to three
    times. An appended line always changes the stamp or size, so
    a hit can never outlive new data, same as _claude_live. A
    missing file evicts and returns no records."""
    if not path:
        return []
    try:
        stamp = Path(path).stat()
    except OSError:
        _LOG_RECORDS_CACHE.pop(str(path), None)
        return []
    version = (stamp.st_mtime_ns, stamp.st_size)
    cached = _LOG_RECORDS_CACHE.get(str(path))
    if cached and cached[0] == version:
        return cached[1]
    records = muse_log.read_records(path)
    _LOG_RECORDS_CACHE[str(path)] = (version, records)
    return records


def live_calls(session_id):
    path = live_session_log(session_id)
    if not path:
        return [], []
    return muse_log.live_calls_from_records(_log_records(path))


_CLAUDE_LIVE_CACHE = {}


def _claude_live(run):
    """Live calls, timeline and state for a running Claude run.

    Reads the run's events.jsonl, which run-muse writes and
    flushes line by line while the harness runs. Empty values
    when the run is not a running Claude Code run, or when the
    file is not there yet. This server only ever reads. One
    request can ask for the same run twice, and the page polls
    every two seconds, so a parse is cached against the file
    stamp and size. An appended line always changes one of
    them, so a stale entry can never outlive new data.
    """
    empty = {"calls": [], "timeline": [], "live_state": None}
    if run.get("provider") != "claude-code" \
            or run.get("status") != "running" or not run.get("run_id"):
        return empty
    events_file = INDEX.parent / str(run["run_id"]) / "events.jsonl"
    try:
        stamp = events_file.stat()
    except OSError:
        return empty
    version = (stamp.st_mtime_ns, stamp.st_size)
    cached = _CLAUDE_LIVE_CACHE.get(run["run_id"])
    if cached and cached[0] == version:
        return cached[1]
    try:
        lines = events_file.read_text(errors="replace").splitlines()
    except OSError:
        return empty
    live = claude_stream.live_from_lines(lines)
    result = {"calls": live["calls"], "timeline": live["timeline"],
              "live_state": live["live_state"]}
    _CLAUDE_LIVE_CACHE[run["run_id"]] = (version, result)
    return result


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


def _run_model_ms(run):
    """Sum of per-call durations, or the harness-reported API total
    when calls carry none (Claude Code reports no per-call time).
    Strict: if any call is missing its duration the per-call total
    is unknown, never a partial sum. None when nothing usable was
    recorded: a dash, never an invented 0. A recorded 0 stays 0."""
    durations = [c.get("duration_ms") for c in (run.get("calls") or [])]
    if durations and all(d is not None for d in durations):
        return sum(durations)
    if run.get("api_ms") is not None:
        return run.get("api_ms")
    return None


def _run_split(run, records=None):
    """Stored time split, or one computed from the session log.

    Buckets with a missing event pair stay None (shown as –), never
    estimated. Only Muse sessions have the underlying events.
    `records` lets the caller pass an already-read log.
    """
    model_ms = _run_model_ms(run)
    empty = {"model_ms": model_ms, "tool_ms": None,
             "approval_ms": None, "muse_ms": None}
    if run.get("tool_ms") is not None or run.get("approval_ms") is not None \
            or run.get("muse_ms") is not None:
        return {"model_ms": model_ms, "tool_ms": run.get("tool_ms"),
                "approval_ms": run.get("approval_ms"),
                "muse_ms": run.get("muse_ms")}
    if not run.get("session_id"):
        return empty
    if records is None:
        path = live_session_log(run["session_id"])
        if not path:
            return empty
        records = _log_records(path)
    return muse_log.time_split(records, run.get("wall_ms"), model_ms)


def _run_tokens(run, key):
    """Run token total from totals when present, else summed calls.

    Strict: if any call is missing the value, or there are no
    calls, the total is None. The page shows a dash, never a
    partial sum dressed up as a total."""
    totals = run.get("totals")
    if totals:
        return totals.get(key)
    values = [c.get(key) for c in (run.get("calls") or [])]
    if not values or any(v is None for v in values):
        return None
    return sum(values)


def load_runs():
    """Index entries: deduped, stale running fixed, live calls filled."""
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
    # Grouped rows should agree with the live stats for running runs.
    enriched = []
    for r in runs:
        if r.get("status") == "running" and r.get("session_id"):
            live, _ = live_calls(r["session_id"])
            if live:
                r = dict(r)
                r["calls"] = live
        elif r.get("status") == "running" \
                and r.get("provider") == "claude-code":
            live = _claude_live(r)["calls"]
            if live:
                r = dict(r)
                r["calls"] = live
        enriched.append(r)
    return enriched


def session_row(r):
    model_ms = _run_model_ms(r)
    return {
        "run_id": r.get("run_id"), "at": r.get("at"),
        "prompt": r.get("prompt"), "model": r.get("model"),
        "wall_ms": r.get("wall_ms"), "calls": len(r.get("calls") or []),
        "provider": r.get("provider"), "context_mode": r.get("context_mode"),
        "comparison_id": r.get("comparison_id"), "round": r.get("round"),
        "compare_mode": r.get("compare_mode"),
        "raced": bool(r.get("raced")),
        "suite_id": r.get("suite_id"), "suite_prompt": r.get("suite_prompt"),
        "harness_version": r.get("harness_version"),
        "cost_usd": r.get("cost_usd"),
        "cost_source": r.get("cost_source"),
        "pricing": r.get("pricing"),
        "allowance_start": r.get("allowance_start"),
        "allowance_end": r.get("allowance_end"),
        "allowance_delta": r.get("allowance_delta"),
        "ttft_ms": r.get("ttft_ms"), "status": r.get("status"),
        "model_ms": model_ms,
        "overhead_ms": None if model_ms is None or r.get("wall_ms") is None
                       else max(0, r["wall_ms"] - model_ms),
        "input_tokens": _run_tokens(r, "input_tokens"),
        "output_tokens": _run_tokens(r, "output_tokens"),
        "tool_ms": r.get("tool_ms"), "approval_ms": r.get("approval_ms"),
        "muse_ms": r.get("muse_ms"),
        "last_input_tokens": (r.get("calls") or [{}])[-1].get("input_tokens"),
        "last_output_tokens": (r.get("calls") or [{}])[-1].get("output_tokens"),
    }


def pick_selected(runs, run_id):
    # With no explicit pick, follow a run in progress so it can be
    # watched live. Otherwise open on the newest completed run, not a
    # failed or interrupted one. Stale "running" entries were already
    # marked interrupted in load_runs, so they can't take over.
    return next((r for r in runs if r.get("run_id") == run_id), None) \
        or next((r for r in reversed(runs) if r.get("status") == "running"),
                None) \
        or next((r for r in reversed(runs) if r.get("status") == "completed"),
                None) \
        or (runs[-1] if runs else {})


def read_logs(run_id=None):
    runs = load_runs()
    sessions = [session_row(r) for r in reversed(runs)]
    selected = pick_selected(runs, run_id)
    live_timeline = []
    claude_live = {"calls": [], "timeline": [], "live_state": None}
    if selected.get("status") == "running" and selected.get("session_id"):
        live, live_timeline = live_calls(selected["session_id"])
        if live:
            selected = dict(selected)
            selected["calls"] = live
    if selected.get("status") == "running" \
            and selected.get("provider") == "claude-code":
        claude_live = _claude_live(selected)
        if claude_live["calls"]:
            selected = dict(selected)
            selected["calls"] = claude_live["calls"]
        if not live_timeline:
            live_timeline = claude_live["timeline"]
    elapsed_ms = None
    if selected.get("status") == "running" and selected.get("at"):
        try:
            started = datetime.fromisoformat(selected["at"])
            elapsed_ms = round((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        except Exception:
            elapsed_ms = None
    # The selected run's session log is read once here; the retry
    # merge, live state and time split below all use these records.
    selected_records = None
    if selected.get("session_id"):
        log_path = live_session_log(selected["session_id"])
        if log_path:
            selected_records = _log_records(log_path)
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
    # Kept after the live-calls change: dropping it would lose the
    # retry on older runs whose stored calls carry no retry fields
    # (e.g. 20261025-100503-bc9687, 1 retry, 181 s stalled).
    if selected_records is not None:
        infos = muse_log.retry_infos(selected_records)
        for index, info in enumerate(infos):
            if index < len(events):
                events[index]["retries"] = info["retries"]
                events[index]["stalled_ms"] = info["stalled_ms"]
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
    # Echo never calls a model, so a missing model record is expected.
    if selected.get("metrics_unavailable") \
            and selected.get("provider") != "echo":
        errors.append({"at": selected.get("at"),
                       "operation": selected.get("run_id"),
                       "error_type": "model metrics unavailable for this run"})
    live_state = None
    if selected.get("status") == "running" and selected_records is not None:
        live_state = muse_log.live_state(selected_records)
    if live_state is None and selected.get("status") == "running":
        live_state = claude_live["live_state"]
    xray = muse_log.input_traces(selected_records) \
        if selected_records is not None else []
    intervals = muse_log.tool_intervals(selected_records) \
        if selected_records is not None else {
            "intervals": [], "unclosed_tools": [],
            "unclosed_approvals": []}
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
            dict(selected, wall_ms=selected.get("wall_ms") or elapsed_ms),
            records=selected_records),
        "events": events, "timeline": timeline, "errors": errors[-3:],
        "xray": xray, "intervals": intervals,
    }


def delete_run(run_id):
    if not run_id or not re.fullmatch(r"[0-9A-Za-z-]+", run_id):
        return False, "invalid run id"
    root = INDEX.parent.resolve()
    target = (root / run_id)
    if target.parent != root:
        return False, "invalid run id"
    with _index_file_lock(INDEX):
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
            mode = stat.S_IMODE(INDEX.stat().st_mode)
            fd, tmp_name = tempfile.mkstemp(
                dir=str(INDEX.parent), prefix="index-", suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as tmp_file:
                    tmp_file.write("".join(l + "\n" for l in kept))
                os.chmod(tmp_name, mode)
                os.replace(tmp_name, INDEX)
            except BaseException:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
                raise
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
