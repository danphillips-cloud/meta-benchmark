"""Published list pricing and subscription allowance maths.

Stdlib only. Used by run-muse to record cost on a run.
Nothing here estimates: any missing recorded count gives
None, and the caller shows a dash.
"""

LIST_SOURCE = "https://dev.meta.ai/docs/pricing-rate-limits"
LIST_FETCHED = "2026-10-31"

# Meta Model API published list, standard mode, USD per million
# tokens. Source: LIST_SOURCE, as fetched on LIST_FETCHED. One
# model only. muse-wonder-full-1.0 has no public per-token
# price and is deliberately absent. It stays a dash.
LIST_PRICES = {
    "muse-wonder-1.0": {
        "input_per_mtok": 4.00,
        "cached_per_mtok": 0.20,
        "output_per_mtok": 20.00,
    },
}


def list_cost(model, totals, calls):
    """(cost_usd, pricing_used) at Meta's list, or (None, None).

    Token semantics differ per path, and the branch encodes it.
    Totals (Claude Code) record input including cached tokens,
    so the fresh part is input minus cached. Calls (direct API)
    record input and cached as separate additive counts. Strict:
    any count the price needs missing gives None.
    """
    rates = LIST_PRICES.get(model)
    if rates is None:
        return None, None
    if totals:
        in_tok = totals.get("input_tokens")
        cached = totals.get("cached_tokens")
        out_tok = totals.get("output_tokens")
        if in_tok is None or cached is None or out_tok is None:
            return None, None
        fresh = in_tok - cached
        if fresh < 0:
            return None, None
        cost = (fresh * rates["input_per_mtok"]
                + cached * rates["cached_per_mtok"]
                + out_tok * rates["output_per_mtok"]) / 1000000
    elif calls:
        def summed(key):
            values = [c.get(key) for c in calls]
            if any(v is None for v in values):
                return None
            return sum(values)

        in_tok = summed("input_tokens")
        cached = summed("cached_tokens")
        out_tok = summed("output_tokens")
        if in_tok is None or cached is None or out_tok is None:
            return None, None
        cost = (in_tok * rates["input_per_mtok"]
                + cached * rates["cached_per_mtok"]
                + out_tok * rates["output_per_mtok"]) / 1000000
    else:
        return None, None
    used = dict(rates)
    used.update({"model": model, "source": LIST_SOURCE,
                 "fetched": LIST_FETCHED})
    return cost, used


def _bucket(allowance, name):
    bucket = allowance.get(name)
    if not isinstance(bucket, dict):
        return None
    percent = bucket.get("used_percent", bucket.get("usedPercent"))
    resets = bucket.get("resets_at_ms", bucket.get("resetsAtMs"))
    for value in (percent, resets):
        if isinstance(value, bool) \
                or not isinstance(value, (int, float)):
            return None
    return {"used_percent": percent, "resets_at_ms": resets}


def allowance_snapshot(obj):
    """One normalised allowance snapshot, or None.

    Accepts a `muse usage --json` object (allowance nested,
    camelCase fields) or a raw stream allowance object
    (snake_case). A limit that is missing or malformed is None
    on its own. The other limit is kept. Only when both are
    unusable is there no snapshot at all. Tier and source are
    dropped. The raw stream line stays in events.jsonl
    regardless.
    """
    if not isinstance(obj, dict):
        return None
    allowance = obj.get("allowance") if "allowance" in obj else obj
    if not isinstance(allowance, dict):
        return None
    window = _bucket(allowance, "window")
    weekly = _bucket(allowance, "weekly")
    if window is None and weekly is None:
        return None
    return {"window": window, "weekly": weekly}


def allowance_delta(start, end):
    """Allowance moved between two snapshots, per bucket.

    This is movement while the run ran. Other Muse use at the
    same time counts too. A bucket is None when a snapshot is
    missing, when the bucket reset in between (resets_at_ms
    differs), or when the percent went down. Never a guess.
    """
    delta = {"window": None, "weekly": None}
    if not start or not end:
        return delta
    for name in delta:
        before = start.get(name) or {}
        after = end.get(name) or {}
        if before.get("resets_at_ms") is None \
                or before.get("resets_at_ms") != after.get("resets_at_ms"):
            continue
        moved = after["used_percent"] - before["used_percent"]
        if moved >= 0:
            delta[name] = moved
    return delta
