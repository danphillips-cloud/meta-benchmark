"""Codex exec JSONL parsing. Stdlib only.

Turn usage is aggregate usage, not per-call telemetry. Arrival times,
items and tool events must never be counted as model calls or model time.
The captured fixture records actual codex-cli 0.167.0-alpha.4.1 output.
"""
import json


def _count(value):
    return value if type(value) is int and value >= 0 else None


def parse_codex_stream(stamped):
    """Parse (arrival_ms, JSON line) pairs without inventing telemetry."""
    result = {"session_id": None, "reply": "", "calls": [],
              "timeline": [], "usage_model": None, "totals": None,
              "completed": False, "error_override": None}
    # Completed agent-message items can include commentary. The last
    # completed agent message is the final answer, not a concatenation.
    for _, line in stamped:
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "thread.started":
            result["session_id"] = event.get("thread_id")
        elif kind == "turn.started":
            result["completed"] = False
            result["totals"] = None
        elif kind == "item.completed":
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                text = item.get("text")
                if isinstance(text, str):
                    result["reply"] = text
        elif kind == "turn.completed":
            result["completed"] = True
            usage = event.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            result["totals"] = {
                "input_tokens": _count(usage.get("input_tokens")),
                "cached_tokens": _count(usage.get("cached_input_tokens")),
                "output_tokens": _count(usage.get("output_tokens")),
                "reasoning_tokens": _count(usage.get("reasoning_output_tokens")),
            }
        elif kind == "turn.failed":
            error = event.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            result["error_override"] = message or "Codex turn failed"
            result["completed"] = False
        elif kind == "error":
            # Transport errors may be retried. A later turn.completed is
            # the authoritative successful outcome. Missing completion
            # still fails even if the process exited zero.
            message = event.get("message")
            if isinstance(message, str):
                result["error_override"] = message
    if result["completed"]:
        result["error_override"] = None
    return result
