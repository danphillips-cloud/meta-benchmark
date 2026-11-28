#!/usr/bin/env python3
"""Build the Step 1 golden fixtures. Run from the repo root:

    python3 testdata/golden/make_golden.py

Writes a controlled muse-runs set under testdata/golden/runs/,
one standalone report.json golden, and api_logs.json produced by
the Python server's own read_logs() pointed at that set. Python
is the oracle. Regenerate only after a deliberate Python change,
and review the diff like a contract change.

Session ids are fake on purpose, so read_logs() finds no Muse
session log and adds no live enrichment. Dates are in the past,
so the one running entry is stale forever.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
RUNS = HERE / "runs"
sys.path.insert(0, str(ROOT / "lib"))
import server  # noqa: E402

AT = "2026-01-01T00:00:00+00:00"
FIN = "2026-01-01T00:00:05+00:00"


def base(run_id, provider, **over):
    """One report dict with every BASE_REPORT key (run-muse)."""
    report = {
        "at": AT, "finished_at": FIN, "run_id": run_id,
        "prompt": "fixture prompt", "model": "fixture-model",
        "provider": provider, "session_id": "session-" + run_id,
        "context_mode": "bare", "comparison_id": None, "round": None,
        "compare_mode": None, "suite_id": None, "suite_prompt": None,
        "billing_mode": None, "requested_model": "fixture-model",
        "harness_version": "fixture-harness-1", "tool_ms": None,
        "approval_ms": None, "muse_ms": None,
        "needs_approval_tool": None, "status": "completed",
        "timeout_seconds": 300, "command": "fixture command",
        "wall_ms": 1000, "exit_code": 0, "reply": "fixture reply",
        "calls": [], "timeline": [], "api_ms": None, "ttft_ms": None,
        "num_turns": None, "cost_usd": None, "cost_source": None,
        "pricing": None, "allowance_start": None,
        "allowance_end": None, "allowance_delta": None,
        "totals": None, "task_validation": None,
        "metrics_unavailable": False, "error": None,
        "turn_index": None, "raced": False,
    }
    report.update(over)
    return report


RICH = base(
    "20260101-000001-c0ffee", "meta",
    model="muse-wonder-1.0", suite_id="suite-a",
    suite_prompt="golden prompt", tool_ms=334.147, approval_ms=0,
    muse_ms=2978.853, wall_ms=5000, ttft_ms=123,
    calls=[
        {"model": None, "duration_ms": 400, "input_tokens": 1000,
         "output_tokens": 50, "cached_tokens": 800,
         "reasoning_tokens": None, "retries": 0, "stalled_ms": None},
        {"model": "muse-wonder-1.0", "duration_ms": 600.5,
         "input_tokens": 1200, "output_tokens": 70,
         "cached_tokens": 900, "reasoning_tokens": 10,
         "retries": 1, "stalled_ms": 250},
    ],
    timeline=[
        {"at": None, "operation": "system init",
         "duration_ms": 10, "wire_ms": None},
        {"at": AT, "operation": "assistant",
         "duration_ms": 400, "wire_ms": 400},
        {"at": FIN, "operation": "result",
         "duration_ms": None, "wire_ms": None},
    ],
    allowance_start={"window": {"used_percent": 1,
                                  "resets_at_ms": 1793763857000},
                       "weekly": {"used_percent": 0,
                                  "resets_at_ms": 1794182400000}},
    allowance_end={"window": {"used_percent": 3,
                                "resets_at_ms": 1793763857000},
                     "weekly": {"used_percent": 0,
                                "resets_at_ms": 1794182400000}},
    allowance_delta={"window": 2, "weekly": None},
    task_validation={"status": "passed", "checks": [
        {"check": "reply_contains", "value": "pong",
         "passed": True}]},
)

FAILED = base(
    "20260101-000002-fa11ed", "claude-code", status="failed",
    exit_code=1, error="API Error: fixture failure", wall_ms=1416,
    api_ms=900, num_turns=1, cost_usd=0.0123, cost_source="list",
    calls=[{"model": "muse-wonder-1.0", "duration_ms": None,
            "input_tokens": 10, "output_tokens": 0,
            "cached_tokens": 0, "reasoning_tokens": None}],
    pricing={"input_per_mtok": 4.0, "cached_per_mtok": 0.2,
             "output_per_mtok": 20.0, "model": "muse-wonder-1.0",
             "source": "fixture pricing", "fetched": "2026-01-01"},
    totals={"input_tokens": 10, "output_tokens": 0,
            "cached_tokens": 0, "cache_creation_tokens": 0},
    timeline=[{"at": AT, "operation": "result",
               "duration_ms": 4, "wire_ms": None}],
)

ECHO = base(
    "20260101-000003-ec4000", "echo", wall_ms=5,
    command="fixture echo", metrics_unavailable=True,
    session_id=None,
)

CODEX = base(
    "20260101-000004-c0de00", "codex", wall_ms=8000,
    reasoning_effort="medium",
    totals={"input_tokens": 500, "output_tokens": 60,
            "cached_tokens": 100, "reasoning_tokens": 40},
)

STALE = base(
    "20260101-000005-57a1e0", "meta", status="running",
    finished_at=None, session_id=None, timeout_seconds=60,
    command=None, wall_ms=None, exit_code=None, reply="",
)

RETRO = base(
    "20260101-000006-re7r00", "muse-retro", wall_ms=500,
    exit_code=None, turn_index=3, outcome_recorded=False,
    calls_started_before_turn=2, tool_ms=10, approval_ms=0,
    muse_ms=20,
    calls=[
        {"model": None, "duration_ms": 300, "input_tokens": 100,
         "output_tokens": 10, "cached_tokens": 0,
         "reasoning_tokens": None, "retries": 0,
         "stalled_ms": None},
        {"model": None, "duration_ms": 300, "input_tokens": 110,
         "output_tokens": 12, "cached_tokens": 0,
         "reasoning_tokens": None, "retries": 0,
         "stalled_ms": None},
    ],
)

# Legacy direct-API shape: the first call has no
# cache_creation_tokens key at all, so its input tokens are
# unknown and the run total is unknown. The second call carries
# the key as null, so its input tokens do count as the last call.
ANTHROPIC = base(
    "20260101-000007-an7h00", "anthropic", wall_ms=900,
    calls=[
        {"model": "claude-fixture", "duration_ms": 250,
         "input_tokens": 999, "output_tokens": 11,
         "cached_tokens": None, "reasoning_tokens": None},
        {"model": "claude-fixture", "duration_ms": 300,
         "input_tokens": 500, "output_tokens": 9,
         "cached_tokens": None, "reasoning_tokens": None,
         "cache_creation_tokens": None},
    ],
)

# The rich run also appears first as a "running" summary, the way
# run-muse registers a run before it finishes. Last entry wins.
RICH_RUNNING = base(
    RICH["run_id"], "meta", status="running", finished_at=None,
    session_id=None, command=None, wall_ms=None, exit_code=None,
    reply="", model=RICH["model"], suite_id=RICH["suite_id"],
    suite_prompt=RICH["suite_prompt"],
)

REPORTS = [RICH, FAILED, ECHO, CODEX, RETRO, ANTHROPIC]
# Index order puts RICH last among deduped runs (first-seen slot),
# so Python picks it as the selected run.
INDEX_ORDER = [STALE, ECHO, FAILED, CODEX, RETRO, ANTHROPIC,
               RICH_RUNNING, RICH]


def summary(report):
    return {k: v for k, v in report.items() if k != "timeline"}


def main():
    RUNS.mkdir(parents=True, exist_ok=True)
    for report in REPORTS:
        run_dir = RUNS / report["run_id"]
        run_dir.mkdir(exist_ok=True)
        (run_dir / "report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n")
    with open(RUNS / "index.jsonl", "w") as f:
        for report in INDEX_ORDER:
            f.write(json.dumps(summary(report), sort_keys=True) + "\n")
    (HERE / "report.json").write_text(
        json.dumps(RICH, indent=2, sort_keys=True) + "\n")
    server.INDEX = RUNS / "index.jsonl"
    (HERE / "api_logs.json").write_text(
        json.dumps(server.read_logs(), indent=2, sort_keys=True) + "\n")
    print("golden fixtures written under", HERE)


if __name__ == "__main__":
    main()
