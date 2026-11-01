#!/usr/bin/env python3
"""Shared Muse session-log parsing for run-muse and server.py.

Stdlib only. Finds a session's log under MUSE_SESSIONS_DIR, pulls
model_completed records (duration plus token counts) out of it, and
builds the per-step timeline. Both the launcher (final harvest) and
the UI server (live view of a running run) read logs through here.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


def sessions_dir():
    return Path(os.environ.get("MUSE_SESSIONS_DIR")
                or Path.home() / ".local/share/muse/sessions")


def session_log_path(session_id):
    if not session_id:
        return None
    files = list(sessions_dir().glob(f"**/{session_id}/session.jsonl"))
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


def _event_kind(e):
    return ((e.get("payload") or {}).get("event") or {}).get("kind")


def _timeline_row(e, node):
    ts = e.get("recorded_at")
    ptype = e.get("payload_type")
    if not ts or not ptype:
        return None
    payload = e.get("payload") or {}
    label = ptype
    kind = _event_kind(e) or payload.get("kind")
    if kind:
        label += f" {kind}"
    return {
        "at": datetime.fromtimestamp(ts / 1_000_000, timezone.utc).isoformat(),
        "operation": label,
        "recorded_at": ts,
        "wire_ms": node.get("duration_ms") if node else None,
    }


def _timeline_rows(records):
    rows = []
    for e in records:
        row = _timeline_row(e, next(find_model_completed(e), None))
        if row:
            rows.append(row)
    return _finish_timeline(rows)


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
    return calls_from_records(read_records(path))


def build_timeline(session_id, wall_ms):
    path = session_log_path(session_id)
    if not path:
        return []
    return _timeline_rows(read_records(path))


def read_records(path):
    """All parseable records of a session log, in log order."""
    if not path:
        return []
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    out.sort(key=lambda e: e.get("sequence") or 0)
    return out


def session_metadata(records):
    """Model, provider and harness version from the metadata record.

    The version is the log's own `build` field. Falls back to
    the start-of-session intake record for the model when the metadata
    record lacks one. Values only — never workspace paths.
    """
    model = provider = version = None
    for e in records:
        payload = e.get("payload") or {}
        record = payload.get("record") or {}
        if e.get("payload_type") == "runtime.session.metadata":
            model = model or record.get("model_id")
            provider = provider or record.get("provider_id")
            build = record.get("build") or {}
            version = version or build.get("semver")
        elif e.get("payload_type") == "runtime.command_intake.received":
            meta = ((record.get("command") or {}).get("session_metadata")
                    or {})
            model = model or meta.get("model_id")
            provider = provider or meta.get("provider_id")
            build = meta.get("build") or {}
            version = version or build.get("semver")
    return {"model": model, "provider": provider, "version": version}


_OPENING = re.compile(r"opening meta model stream attempt (\d+)/(\d+)")
_RETRYING = re.compile(r"retrying meta model stream in (\d+)ms \(attempt (\d+)/(\d+)\)")


def _status_message(e):
    if _event_kind(e) == "status":
        ev = (e.get("payload") or {}).get("event") or {}
        return ev.get("message") or ""
    return ""


def _fresh_retry():
    return {"openings": [], "delays": [], "retries": 0}


def _stalled_ms(info):
    if len(info["openings"]) < 2:
        return None
    return round(info["openings"][-1] - info["openings"][0]
                 - sum(info["delays"]))


def calls_from_records(records):
    """Model calls (harvest shape) from already-parsed records.

    Retries are built in the same loop: status events accumulate
    until the record that carries the call's model_completed node,
    so a retry can only attach to the call in its own record. A
    record holding two nodes attaches the retry to the first node
    only, so the retry is never counted twice. `stalled_ms` is the
    time from attempt 1 opening to the final attempt opening, minus
    the announced retry delays; it stays inside `duration_ms`.
    Calls with no status events get retries 0 and stalled_ms None.
    """
    calls = []
    pending = None
    for e in records:
        kind = _event_kind(e)
        if kind == "model_request_configured":
            pending = _fresh_retry()
        msg = _status_message(e)
        if msg:
            if pending is None:
                pending = _fresh_retry()
            opened = _OPENING.search(msg)
            if opened and e.get("recorded_at") is not None:
                pending["openings"].append(e["recorded_at"] / 1000)
            retry = _RETRYING.search(msg)
            if retry:
                pending["retries"] += 1
                pending["delays"].append(int(retry.group(1)))
        nodes = list(find_model_completed(e))
        if not nodes:
            continue
        info = pending or _fresh_retry()
        stalled = _stalled_ms(info)
        for index, node in enumerate(nodes):
            usage = node["usage"]
            calls.append({
                "model": find_value(e, "model_id"),
                "duration_ms": node.get("duration_ms"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "cached_tokens": usage.get("cached_tokens"),
                "reasoning_tokens": usage.get("reasoning_tokens"),
                "retries": info["retries"] if index == 0 else 0,
                "stalled_ms": stalled if index == 0 else None,
            })
        pending = None
    return calls


def retry_infos(records):
    """Per-call retry data, in call order (see calls_from_records)."""
    return [{"retries": c["retries"], "stalled_ms": c["stalled_ms"]}
            for c in calls_from_records(records)]


def _paired_intervals(records, started_type, terminal_type, id_key):
    """(closed intervals, unclosed names) for one effect type.

    Intervals are (start_ms, end_ms, name) from `recorded_at`
    (microseconds). Pairing is by the record's id field; a started
    record with no terminal is reported unclosed, never estimated.
    """
    open_map = {}
    intervals = []
    for e in records:
        ptype = e.get("payload_type")
        if ptype not in (started_type, terminal_type):
            continue
        record = (e.get("payload") or {}).get("record") or {}
        ts = e.get("recorded_at")
        if ts is None:
            continue
        ms = round(ts / 1000)
        if ptype == started_type:
            open_map[record.get(id_key)] = (ms, record.get("tool_name"))
        elif record.get(id_key) in open_map:
            start_ms, name = open_map.pop(record.get(id_key))
            intervals.append((start_ms, ms, name))
    unclosed = [name for _, name in open_map.values()]
    return intervals, unclosed


def _overlap_ms(a, b):
    total = 0
    for s1, e1, _ in a:
        for s2, e2, _ in b:
            total += max(0, min(e1, e2) - max(s1, s2))
    return total


def time_split(records, wall_ms, model_ms):
    """Model/tool/approval/Muse split from event timestamps.

    No estimates: a started effect with no terminal makes its bucket
    None, and Muse time (wall minus the other three) is then None
    too. A bucket with no events at all is a recorded 0. Approval
    overlap is subtracted from tool time so nested approvals are
    never counted twice.
    """
    tool_iv, tool_open = _paired_intervals(
        records, "tool_batch.effect.started",
        "tool_batch.effect.terminal", "effect_id")
    appr_iv, appr_open = _paired_intervals(
        records, "approval_wait.effect.started",
        "approval_wait.effect.terminal", "pending_action_id")
    approval_ms = None if appr_open else sum(e - s for s, e, _ in appr_iv)
    if tool_open:
        tool_ms = None
    else:
        tool_ms = sum(e - s for s, e, _ in tool_iv)
        if approval_ms:
            tool_ms = max(0, tool_ms - _overlap_ms(tool_iv, appr_iv))
    if wall_ms is None or model_ms is None \
            or tool_ms is None or approval_ms is None:
        muse_ms = None
    else:
        muse_ms = max(0, wall_ms - model_ms - tool_ms - approval_ms)
    return {"model_ms": model_ms, "tool_ms": tool_ms,
            "approval_ms": approval_ms, "muse_ms": muse_ms}


def _ms_to_iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def tool_intervals(records):
    """Named tool and approval intervals, exactly as recorded.

    Pure. Closed intervals carry kind, name, ISO start and end and
    duration. A tool interval also carries `wait_ms`, the approval
    overlap inside it, from the same overlap maths `time_split`
    uses. Full durations stay as recorded: callers decide how to
    present the nesting. Started effects with no terminal come back
    as names only, never with invented durations.
    """
    records = records or []
    tool_iv, tool_open = _paired_intervals(
        records, "tool_batch.effect.started",
        "tool_batch.effect.terminal", "effect_id")
    appr_iv, appr_open = _paired_intervals(
        records, "approval_wait.effect.started",
        "approval_wait.effect.terminal", "pending_action_id")
    intervals = []
    for start, end, name in tool_iv:
        intervals.append({
            "kind": "tool", "name": name,
            "start_at": _ms_to_iso(start), "end_at": _ms_to_iso(end),
            "duration_ms": end - start,
            "wait_ms": _overlap_ms([(start, end, name)], appr_iv),
        })
    for start, end, name in appr_iv:
        intervals.append({
            "kind": "approval", "name": name,
            "start_at": _ms_to_iso(start), "end_at": _ms_to_iso(end),
            "duration_ms": end - start, "wait_ms": 0,
        })
    intervals.sort(key=lambda i: i["start_at"])
    return {"intervals": intervals,
            "unclosed_tools": tool_open,
            "unclosed_approvals": appr_open}


def live_state(records):
    """Current state of a live session, from its log records only.

    Pure. Returns {"state", "tool"} with state one of: ended,
    waiting for approval, tool running, model call running, idle.
    """
    if any(e.get("payload_type") == "session.end" for e in records):
        return {"state": "ended", "tool": None}
    _, appr_open = _paired_intervals(
        records, "approval_wait.effect.started",
        "approval_wait.effect.terminal", "pending_action_id")
    if appr_open:
        return {"state": "waiting for approval", "tool": appr_open[-1]}
    _, tool_open = _paired_intervals(
        records, "tool_batch.effect.started",
        "tool_batch.effect.terminal", "effect_id")
    if tool_open:
        return {"state": "tool running", "tool": tool_open[-1]}
    configured = completed = 0
    attempt = None
    for e in records:
        kind = _event_kind(e)
        if kind == "model_request_configured":
            configured += 1
            attempt = None
        elif kind == "model_completed":
            completed += 1
            attempt = None
        msg = _status_message(e)
        if msg:
            opened = _OPENING.search(msg)
            retry = _RETRYING.search(msg)
            if retry:
                attempt = f"{retry.group(2)}/{retry.group(3)}"
            elif opened and int(opened.group(1)) >= 2:
                attempt = f"{opened.group(1)}/{opened.group(2)}"
    if configured > completed and attempt:
        return {"state": "retrying connection", "tool": None,
                "attempt": attempt}
    if configured > completed:
        return {"state": "model call running", "tool": None}
    return {"state": "idle", "tool": None}


def live_state_from_log(path):
    return live_state(read_records(path))


_ACTIVITY_KINDS = ("model_completed",)
_ACTIVITY_TYPES = ("tool_batch.effect.terminal",
                   "approval_wait.effect.terminal")


def _is_activity(e):
    kind = _event_kind(e)
    if kind in _ACTIVITY_KINDS:
        return True
    if e.get("payload_type") in _ACTIVITY_TYPES:
        return True
    return kind == "assistant_message_committed"


def _prompt_of(accepted):
    payload = accepted.get("payload") or {}
    for msg in payload.get("model_messages") or []:
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("text"):
                return block["text"]
    return ""


def split_turns(records):
    """Finished interactive turns, segmented on user_intent.accepted.

    A turn closes when the next accepted record (or session.end)
    arrives; the trailing turn is returned only when the session has
    ended. Turn wall ends at the segment's last activity record, so
    user think time between turns never counts. Turns with no model
    call are skipped — there is nothing measured to record.
    """
    meta = session_metadata(records)
    starts = [i for i, e in enumerate(records)
              if e.get("payload_type") == "runtime.user_intent.accepted"]
    ended = any(e.get("payload_type") == "session.end" for e in records)
    turns = []
    for n, start in enumerate(starts):
        is_last = n + 1 == len(starts)
        if is_last and not ended:
            break
        stop = starts[n + 1] if not is_last else len(records)
        seg = records[start:stop]
        calls = calls_from_records(seg)
        if not calls:
            continue
        activity = [e.get("recorded_at") for e in seg if _is_activity(e)]
        start_us = records[start].get("recorded_at")
        if start_us is None or not activity:
            continue
        wall_ms = round((max(activity) - start_us) / 1000)
        durations = [c["duration_ms"] for c in calls]
        # A call that was already running when the user sent this
        # turn's message started in the previous turn. Its full
        # duration would be counted here, so model time can exceed
        # wall. Count such calls from recorded timestamps only.
        early = 0
        for e in seg:
            done_us = e.get("recorded_at")
            for node in find_model_completed(e):
                dur = node.get("duration_ms")
                if done_us is not None and dur is not None \
                        and done_us - dur * 1000 < start_us:
                    early += 1
        # Strict: one missing duration makes the turn total unknown,
        # so time_split leaves muse_ms as None instead of absorbing
        # the gap as Muse time. An early call makes it unknown too.
        model_ms = sum(durations) \
            if all(d is not None for d in durations) and not early \
            else None
        turns.append({
            "index": n + 1,
            "prompt": _prompt_of(records[start]),
            "at": datetime.fromtimestamp(
                start_us / 1_000_000, timezone.utc).isoformat(),
            "wall_ms": wall_ms, "calls": calls,
            "timeline": _timeline_rows(seg),
            "split": time_split(seg, wall_ms, model_ms),
            "model": meta["model"], "version": meta["version"],
            "calls_started_before_turn": early,
        })
    return turns


def newest_session_path():
    files = list(sessions_dir().glob("**/session.jsonl"))
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def live_calls_from_records(records):
    """Calls and timeline from parsed records of a growing log.

    Calls come from calls_from_records, so a running run shows the
    same calls (retry fields included) as the finished run.
    """
    return calls_from_records(records), _timeline_rows(records)


def live_calls_from_log(path):
    return live_calls_from_records(read_records(path))


def _lane_value(node):
    return (node or {}).get("value")


def input_traces(records):
    """Per-step request lane bytes from model_input_trace_recorded.

    Pure. Byte counts only, exactly as recorded: lane aggregates
    carry no message text and bytes are never converted to tokens.
    Omitted group and byte counts pass through untouched so callers
    can say when a breakdown is partial. No traces, empty list.
    """
    traces = []
    for e in records or []:
        if _event_kind(e) != "model_input_trace_recorded":
            continue
        event = (e.get("payload") or {}).get("event") or {}
        bounded = event.get("bounded") or {}
        lanes = [{
            "lane": _lane_value(a.get("logical_lane")),
            "source": _lane_value(a.get("source")),
            "wire": _lane_value(a.get("provider_wire_destination")),
            "bytes": a.get("byte_count"),
            "lane_count": a.get("lane_count"),
        } for a in bounded.get("aggregates") or []]
        traces.append({
            "step": event.get("model_step"),
            "total_bytes": bounded.get("total_lane_bytes"),
            "user_bytes": bounded.get("current_user_message_bytes"),
            "omitted_groups": bounded.get("omitted_aggregate_group_count"),
            "omitted_bytes": bounded.get("omitted_aggregate_lane_bytes"),
            "lanes": lanes,
        })
    return traces
