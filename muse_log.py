#!/usr/bin/env python3
"""Shared Muse session-log parsing for run-muse and server.py.

Stdlib only. Finds a session's log under MUSE_SESSIONS_DIR, pulls
model_completed records (duration plus token counts) out of it, and
builds the per-step timeline. Both the launcher (final harvest) and
the UI server (live view of a running run) read logs through here.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def session_log_path(session_id):
    if not session_id:
        return None
    base = Path(os.environ.get("MUSE_SESSIONS_DIR")
                or Path.home() / ".local/share/muse/sessions")
    files = list(base.glob(f"**/{session_id}/session.jsonl"))
    return files[0] if files else None


def find_model_completed(node):
    if isinstance(node, dict):
        if node.get("kind") == "model_completed" and isinstance(node.get("usage"), dict):
            yield node
        for v in node.values():
            yield from find_model_completed(v)
    elif isinstance(node, list):
        for v in node:
            yield from find_model_completed(v)


def find_value(node, key):
    if isinstance(node, dict):
        if node.get(key):
            return node[key]
        for v in node.values():
            found = find_value(v, key)
            if found:
                return found
    elif isinstance(node, list):
        for v in node:
            found = find_value(v, key)
            if found:
                return found
    return None


def _records(path):
    for line in path.read_text(errors="replace").splitlines():
        try:
            yield json.loads(line)
        except Exception:
            continue


def _timeline_row(e, node):
    ts = e.get("recorded_at")
    ptype = e.get("payload_type")
    if not ts or not ptype:
        return None
    payload = e.get("payload") or {}
    event = payload.get("event") or {}
    label = ptype
    kind = event.get("kind") or payload.get("kind")
    if kind:
        label += f" {kind}"
    return {
        "at": datetime.fromtimestamp(ts / 1_000_000, timezone.utc).isoformat(),
        "operation": label,
        "recorded_at": ts,
        "wire_ms": node.get("duration_ms") if node else None,
    }


def _finish_timeline(rows):
    for i, row in enumerate(rows):
        nxt = rows[i + 1]["recorded_at"] if i + 1 < len(rows) else None
        row["duration_ms"] = round((nxt - row["recorded_at"]) / 1000) if nxt else 0
        del row["recorded_at"]
    return rows


def harvest_calls(session_id):
    path = session_log_path(session_id)
    if not path:
        return []
    calls = []
    for line in path.read_text(errors="replace").splitlines():
        if "model_completed" not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        for node in find_model_completed(e):
            usage = node["usage"]
            calls.append({
                "model": find_value(e, "model_id"),
                "duration_ms": node.get("duration_ms"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "cached_tokens": usage.get("cached_tokens"),
                "reasoning_tokens": usage.get("reasoning_tokens"),
            })
    return calls


def build_timeline(session_id, wall_ms):
    path = session_log_path(session_id)
    if not path:
        return []
    rows = []
    for e in _records(path):
        node = next(find_model_completed(e), None)
        row = _timeline_row(e, node)
        if row:
            rows.append(row)
    return _finish_timeline(rows)


def live_calls_from_log(path):
    """Calls and timeline from a log that may still be growing.

    One call per record, from its last model_completed node, with the
    model left as None (the live view labels calls from the run).
    """
    calls, timeline = [], []
    for e in _records(path):
        nodes = list(find_model_completed(e))
        node = nodes[-1] if nodes else None
        if node:
            u = node["usage"]
            calls.append({"model": None, "duration_ms": node.get("duration_ms"),
                          "input_tokens": u.get("input_tokens"),
                          "output_tokens": u.get("output_tokens"),
                          "cached_tokens": u.get("cached_tokens"),
                          "reasoning_tokens": u.get("reasoning_tokens")})
        row = _timeline_row(e, node)
        if row:
            timeline.append(row)
    return calls, _finish_timeline(timeline)
