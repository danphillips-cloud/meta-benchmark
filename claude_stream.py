"""Claude Code stream-json parsing. Stdlib only.

`run-muse` uses this to build a finished run report from the
stamped lines `run_process` collected, and to print progress
while the run is going. `server.py` uses the live side to show
a Claude Code run in progress, from the same lines as they
land in its events file. All three share one tracker, so a
call, a running tool, and a live state mean the same thing in
the report, the terminal, and the page.
"""
import json


def _input_with_cache(usage):
    parts = [usage.get("input_tokens"), usage.get("cache_read_input_tokens"),
             usage.get("cache_creation_input_tokens")]
    if all(p is None for p in parts):
        return None
    return sum(p or 0 for p in parts)


def _content_blocks(event):
    content = (event.get("message") or {}).get("content")
    return content if isinstance(content, list) else []


def new_live_tracker():
    """Fresh incremental state for feed_live_event."""
    return {"ids": set(), "tools": {}, "calls": [],
            "usage_model": None, "ended": False, "seen_any": False}


def feed_live_event(tracker, event):
    """Apply one parsed stream event to a tracker.

    Returns the new call dict when a fresh message lands, else
    None. Claude Code sends one assistant event per content
    block, and every block of one message shares its id. Tool
    blocks are therefore scanned on every assistant event,
    before the id dedup that keeps the message to one call.
    Scanning after dedup would miss the common text then tool
    sequence entirely.
    """
    if not isinstance(event, dict):
        return None
    tracker["seen_any"] = True
    etype = event.get("type")
    if etype == "assistant":
        msg = event.get("message") or {}
        # Claude Code emits a "<synthetic>" message to carry an error.
        # It is not a model call and holds no real tool work.
        if msg.get("model") == "<synthetic>":
            return None
        for block in _content_blocks(event):
            if isinstance(block, dict) \
                    and block.get("type") == "tool_use" \
                    and block.get("id"):
                tracker["tools"][block["id"]] = block.get("name")
        mid = msg.get("id")
        if mid and mid in tracker["ids"]:
            return None
        if mid:
            tracker["ids"].add(mid)
        usage = msg.get("usage") or {}
        tracker["usage_model"] = msg.get("model") \
            or tracker["usage_model"]
        # Meta's endpoint sends all-zero per-call usage. A real call
        # always has input, so 0 means not reported.
        input_tokens = _input_with_cache(usage) or None
        call = {
            "model": msg.get("model"), "duration_ms": None,
            "input_tokens": input_tokens,
            "output_tokens": None,
            "cached_tokens": usage.get("cache_read_input_tokens")
                             if input_tokens else None,
            "reasoning_tokens": None,
        }
        tracker["calls"].append(call)
        return call
    if etype == "user":
        for block in _content_blocks(event):
            if isinstance(block, dict) \
                    and block.get("type") == "tool_result":
                tracker["tools"].pop(block.get("tool_use_id"), None)
        return None
    if etype == "result":
        tracker["ended"] = True
    return None


def tracker_live_state(tracker):
    """Live state for a tracker, in muse_log.live_state names."""
    if tracker["ended"]:
        return {"state": "ended", "tool": None}
    if tracker["tools"]:
        return {"state": "tool running",
                "tool": list(tracker["tools"].values())[-1]}
    if tracker["seen_any"]:
        return {"state": "model call running", "tool": None}
    return {"state": "idle", "tool": None}


def _parse_events(events):
    """Report fields from (arrival_ms, event) pairs, parsed once."""
    tracker = new_live_tracker()
    timeline = []
    result, session_id = None, None
    for i, (arrival, e) in enumerate(events):
        session_id = session_id or e.get("session_id")
        etype = e.get("type")
        label = etype or "event"
        if e.get("subtype"):
            label += f" {e['subtype']}"
        has_next = i + 1 < len(events)
        nxt = events[i + 1][0] if has_next else None
        if has_next and nxt is not None and arrival is not None:
            duration_ms = nxt - arrival
        elif not has_next and arrival is not None:
            duration_ms = 0
        else:
            duration_ms = None
        timeline.append({
            "at": e.get("timestamp"), "operation": label,
            "duration_ms": duration_ms,
            "wire_ms": None,
        })
        feed_live_event(tracker, e)
        if etype == "result":
            result = e
    parsed = {"session_id": session_id, "reply": "",
              "calls": tracker["calls"], "timeline": timeline,
              "usage_model": tracker["usage_model"],
              "api_ms": None, "ttft_ms": None, "num_turns": None,
              "cost_usd": None, "totals": None, "is_error": False,
              "api_error_status": None,
              "live_state": tracker_live_state(tracker)}
    if result:
        usage = result.get("usage") or {}
        parsed.update({
            "session_id": result.get("session_id") or session_id,
            "reply": result.get("result") or "",
            "api_ms": result.get("duration_api_ms"),
            "ttft_ms": result.get("ttft_ms"),
            "num_turns": result.get("num_turns"),
            "cost_usd": result.get("total_cost_usd"),
            "is_error": bool(result.get("is_error")),
            "api_error_status": result.get("api_error_status"),
            "totals": {
                "input_tokens": _input_with_cache(usage),
                "output_tokens": usage.get("output_tokens"),
                "cached_tokens": usage.get("cache_read_input_tokens"),
            },
        })
        models = list((result.get("modelUsage") or {}).keys())
        if models and not parsed["usage_model"]:
            parsed["usage_model"] = models[0]
    return parsed


def _events_from_lines(stamped):
    events = []
    for arrival, line in stamped:
        try:
            events.append((arrival, json.loads(line)))
        except Exception:
            continue
    return events


def parse_claude_stream(stamped):
    """Map stamped Claude Code stream-json lines onto report fields.

    stamped holds (arrival_ms, line) pairs from run_process. An
    arrival may be None when the caller only has the lines, as
    the server does for a live run. Timeline durations then
    stay None instead of inventing a measurement. One call
    per unique assistant message.id. Claude Code reports no
    per-call duration, and per-call output counts are partial
    snapshots, so both stay None and output totals come from
    the result event. result.usage.iterations only holds the
    last call, so it is not used.
    """
    return _parse_events(_events_from_lines(stamped))


def live_from_lines(lines):
    """Live calls, timeline and state for a run in progress.

    Takes raw stream-json lines as they land in events.jsonl.
    Each line is parsed once. Durations stay None, since the
    file holds no arrival stamps.
    """
    parsed = _parse_events(
        _events_from_lines([(None, line) for line in lines]))
    return {"calls": parsed["calls"], "timeline": parsed["timeline"],
            "session_id": parsed["session_id"],
            "live_state": parsed["live_state"]}
