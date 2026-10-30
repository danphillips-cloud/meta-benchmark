// Pure formatting + scoping helpers, ported 1:1 from the vanilla page.
// A missing metric always renders as "–", never as 0.

export const shortText = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// A prompt past either limit would fill the Selected run panel and push
// the stat cards off screen, so Overview shows it clamped with a toggle.
export const PROMPT_LONG_CHARS = 300;
export const PROMPT_LONG_LINES = 3;

export const isLongPrompt = (s) => {
  s = String(s ?? "");
  return s.length > PROMPT_LONG_CHARS || s.split("\n").length > PROMPT_LONG_LINES;
};

// Collapsed form of a long prompt. Keeps the first lines, then cuts on a
// word boundary so the preview ends cleanly instead of mid word.
export const PROMPT_PREVIEW_CHARS = 280;

export const promptPreview = (s) => {
  s = String(s ?? "");
  if (!isLongPrompt(s)) return s;
  let head = s.split("\n").slice(0, PROMPT_LONG_LINES).join("\n");
  if (head.length > PROMPT_PREVIEW_CHARS) {
    head = head.slice(0, PROMPT_PREVIEW_CHARS);
    const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
    if (cut > 0) head = head.slice(0, cut);
  }
  return head.replace(/\s+$/, "") + "…";
};

export const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
export const fmtMs = (n) => (n == null ? "–" : fmt(Math.round(n)));

// Cost is shown only when recorded or computed from recorded tokens
// at rates the user supplied. Claude Code prices every model from
// Anthropic's list, so a reported cost for a muse- model is not a
// Meta price and stays hidden. A computed cost uses the user's own
// rates, so it is shown for any model.
export const visibleCost = (s) => {
  if (!s || s.cost_usd == null) return null;
  if (String(s.model || "").startsWith("muse-")
    && s.cost_source !== "computed") return null;
  return s.cost_usd;
};

export const fmtCost = (n) => (n == null ? "–" : "$" + Number(n).toFixed(4));

export const costNote = (s) => {
  if (!s || visibleCost(s) == null) return "not recorded";
  return s.cost_source === "computed" ? "at your rates" : "reported";
};

export const fmtDurParts = (n) => {
  if (n == null) return ["–", ""];
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(Math.round(n));
  if (a < 1000) return [sign + fmt(a), " ms"];
  if (a < 60000) return [sign + (a / 1000).toFixed(1), " s"];
  const m = Math.floor(a / 60000), rem = a % 60000;
  return [sign + m + "m " + (rem / 1000).toFixed(1), " s"];
};

export const fmtDur = (n) => {
  const p = fmtDurParts(n);
  return p[0] + p[1];
};

export const fmtDurExact = (n) =>
  n == null ? "–" : (Math.abs(n) >= 1000 ? fmtDur(n) + " (" + fmtMs(n) + " ms)" : fmtDur(n));

export const localTime = (iso) => {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate())
    + " " + p(dt.getHours()) + ":" + p(dt.getMinutes()) + ":" + p(dt.getSeconds());
};

export const timeHM = (iso) => localTime(iso).slice(11, 16);

export function median(values) {
  const nums = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export const legKey = (s) => (s.provider || "?") + "/" + (s.model || "?");

// Live progress for legs still running, in start order. Elapsed is
// now minus the recorded start, never estimated: a missing start
// gives null, which renders as a dash. Calls and model time are
// the live counts the server already returns on session rows.
export function raceProgress(sessions, nowMs) {
  return [...(sessions || [])]
    .filter((s) => s && s.status === "running")
    .sort((a, b) => ((a.at ? 0 : 1) - (b.at ? 0 : 1))
      || String(a.at || "").localeCompare(String(b.at || "")))
    .map((s) => {
      const start = s.at ? Date.parse(s.at) : NaN;
      return {
        run_id: s.run_id, leg: legKey(s), status: s.status,
        elapsed_ms: Number.isFinite(start) && nowMs != null
          ? Math.max(0, nowMs - start) : null,
        calls: s.calls ?? null, model_ms: s.model_ms ?? null,
      };
    });
}

export const STATUSES = ["completed", "running", "failed", "interrupted", "timeout", "needs_approval"];
export const DID_NOT_COMPLETE = STATUSES.filter((s) => s !== "completed" && s !== "running");

// Fastest group(s) by median wall time. Rows carry {key, wall};
// returns the tied-fastest keys and the slowest/fastest ratio, or
// no keys and a null ratio when fewer than two groups have a wall
// time or all walls are equal.
export function fastestOf(rows) {
  const valid = (rows || []).filter((r) => r.wall != null && r.wall > 0);
  if (valid.length < 2) return { fastestKeys: new Set(), fastRatio: null };
  const minWall = Math.min(...valid.map((r) => r.wall));
  const maxWall = Math.max(...valid.map((r) => r.wall));
  if (maxWall <= minWall) return { fastestKeys: new Set(), fastRatio: null };
  return {
    fastestKeys: new Set(valid.filter((r) => r.wall === minWall).map((r) => r.key)),
    fastRatio: maxWall / minWall,
  };
}

export function filterOptions(sessions) {
  const all = sessions || [];
  return {
    providers: [...new Set(all.map((s) => s.provider).filter(Boolean))].sort(),
    models: [...new Set(all.map((s) => s.model).filter(Boolean))].sort(),
  };
}

// Medians and the Recent runs chart scope to the selected run's compare
// set, or to every run sharing its prompt, or to all runs.
export function scopedRuns(d) {
  const sessions = d.sessions || [];
  const sel = sessions.find((s) => s.run_id === d.selected);
  if (!sel) return { runs: sessions, label: "All runs · " + sessions.length + (sessions.length === 1 ? " run" : " runs") };
  if (sel.comparison_id) {
    const runs = sessions.filter((s) => s.comparison_id === sel.comparison_id);
    return { runs, label: "Compare set · " + runs.length + (runs.length === 1 ? " run" : " runs") };
  }
  const prompt = sel.prompt ?? d.prompt ?? "";
  const runs = sessions.filter((s) => (s.prompt ?? "") === prompt);
  return { runs, label: "This prompt · " + runs.length + (runs.length === 1 ? " run" : " runs") };
}

// --- Runs table state ----------------------------------------------
// Filters and sort for /runs live in the URL query string so a filtered
// view is linkable and survives refresh. These pure helpers own the
// mapping both ways, plus filtering and honest sorting (missing values
// always sort last, never as 0).

export const RUNS_PAGE_SIZE = 50;
export const RUNS_SORTS = ["at", "prompt", "provider_model", "mode", "status", "harness_version", "calls", "wall_ms", "model_ms", "overhead_ms"];
export const RUNS_DEFAULT_SORT = { sort: "at", dir: "desc" };

export function runMode(s) {
  return (s && s.compare_mode) || "single";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (v) => (DATE_RE.test(v || "") ? v : "");

export function parseRunsQuery(params) {
  const p = typeof params === "string" ? new URLSearchParams(params) : params;
  const get = (k) => (p && typeof p.get === "function" ? (p.get(k) ?? "") : "");
  const sort = RUNS_SORTS.includes(get("sort")) ? get("sort") : RUNS_DEFAULT_SORT.sort;
  const dirRaw = get("dir");
  const dir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : RUNS_DEFAULT_SORT.dir;
  return {
    q: get("q"), provider: get("provider"), model: get("model"),
    status: get("status"), mode: get("mode"), version: get("version"), sort, dir,
    from: validDate(get("from")), to: validDate(get("to")),
  };
}

export function buildRunsQuery({ q, provider, model, status, mode, version, sort, dir, from, to }) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (provider) p.set("provider", provider);
  if (model) p.set("model", model);
  if (status) p.set("status", status);
  if (mode) p.set("mode", mode);
  if (version) p.set("version", version);
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if (sort !== RUNS_DEFAULT_SORT.sort || dir !== RUNS_DEFAULT_SORT.dir) {
    p.set("sort", sort);
    p.set("dir", dir);
  }
  return p;
}

// --- Shared filters -------------------------------------------------
// One filter state (provider, model, prompt text, date range) lives in
// the URL query and is read by the Overview chart, the medians panel
// and the Runs table. Status/mode stay Runs-only extras on top of it.
export const FILTER_KEYS = ["q", "provider", "model", "status", "mode", "version", "from", "to"];

export function parseSharedFilters(params) {
  const s = parseRunsQuery(params);
  return { q: s.q, provider: s.provider, model: s.model, from: s.from, to: s.to };
}

export function hasSharedFilters(f) {
  return Boolean(f && (f.q || f.provider || f.model || f.from || f.to));
}

export function inDateRange(at, from, to) {
  if (!from && !to) return true;
  const t = at ? new Date(at).getTime() : NaN;
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from + "T00:00:00").getTime()) return false;
  if (to && t > new Date(to + "T23:59:59.999").getTime()) return false;
  return true;
}

// Overview scope: with any shared filter set, the chart and medians use
// the filtered runs across all sessions; with none, today's scoping
// (selected run's compare set, or its prompt, or all runs) applies.
export function overviewScope(d, filters) {
  if (!hasSharedFilters(filters)) return scopedRuns(d);
  const runs = filterSessions(d.sessions || [], {
    q: filters.q, provider: filters.provider, model: filters.model,
    status: "", mode: "", from: filters.from, to: filters.to,
  });
  return { runs, label: "Filtered · " + runs.length + (runs.length === 1 ? " run" : " runs") };
}

export function activeFilterChips(f) {
  const chips = [];
  if (!f) return chips;
  if (f.provider) chips.push({ key: "provider", label: "Provider: " + f.provider });
  if (f.model) chips.push({ key: "model", label: "Model: " + f.model });
  if (f.q) chips.push({ key: "q", label: "Prompt: " + f.q });
  if (f.from || f.to) chips.push({ key: "date", label: "Date: " + (f.from || "…") + " → " + (f.to || "…") });
  if (f.status) chips.push({ key: "status", label: "Status: " + f.status });
  if (f.mode) chips.push({ key: "mode", label: "Mode: " + f.mode });
  if (f.version) chips.push({ key: "version", label: "Version: " + f.version });
  return chips;
}

// Clicking a column header cycles asc -> desc -> back to the default.
export function nextRunsSort(current, sortId) {
  if (current.sort !== sortId) return { sort: sortId, dir: sortId === "at" ? "desc" : "asc" };
  if (current.dir === "asc") return { sort: sortId, dir: "desc" };
  return { ...RUNS_DEFAULT_SORT };
}

export function filterSessions(sessions, f) {
  const q = (f.q || "").trim().toLowerCase();
  return (sessions || []).filter((s) =>
    (!q || (s.prompt || s.run_id || "").toLowerCase().includes(q)) &&
    (!f.provider || s.provider === f.provider) &&
    (!f.model || s.model === f.model) &&
    (!f.status || s.status === f.status) &&
    (!f.mode || runMode(s) === f.mode) &&
    (!f.version || s.harness_version === f.version) &&
    inDateRange(s.at, f.from || "", f.to || ""));
}

// --- Chart data ------------------------------------------------------
// Stacked bars in seconds. Honesty: a run with no reported model time
// contributes overhead only; the split is never estimated. A run with
// no wall time draws nothing and its tooltip says "not reported".
export const fmtSec = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(3) + " s");
export const BRUSH_MIN_RUNS = 12;
export const showBrush = (count) => count > BRUSH_MIN_RUNS;

export function chartDatum(s, selectedId) {
  const wall = s.wall_ms == null ? null : s.wall_ms;
  const hasModel = s.model_ms != null && s.model_ms > 0 && wall != null;
  const modelMs = hasModel ? Math.min(s.model_ms, wall) : 0;
  const overMs = wall == null ? 0
    : (s.model_ms != null && s.overhead_ms != null ? Math.max(0, s.overhead_ms) : Math.max(0, wall - modelMs));
  return {
    run_id: s.run_id, at: s.at, time: timeHM(s.at),
    wall_ms: wall, model_ms: s.model_ms ?? null, overhead_ms: wall == null ? null : overMs,
    model_s: modelMs / 1000, overhead_s: overMs / 1000,
    status: s.status || "unknown",
    provider: s.provider || "?", model: s.model || "?",
    prompt: s.prompt || "",
    isSelected: Boolean(selectedId) && s.run_id === selectedId,
    greyed: DID_NOT_COMPLETE.includes(s.status) || !STATUSES.includes(s.status),
  };
}

export function chartData(runs, selectedId) {
  return [...(runs || [])].reverse().map((s) => chartDatum(s, selectedId));
}

const SORT_VALUE = {
  at: (s) => s.at || null,
  prompt: (s) => s.prompt || null,
  provider_model: (s) => legKey(s),
  mode: (s) => runMode(s),
  status: (s) => s.status || null,
  harness_version: (s) => s.harness_version || null,
  calls: (s) => (s.calls == null ? null : s.calls),
  wall_ms: (s) => (s.wall_ms == null ? null : s.wall_ms),
  model_ms: (s) => (s.model_ms == null ? null : s.model_ms),
  overhead_ms: (s) => (s.overhead_ms == null ? null : s.overhead_ms),
  cost_usd: (s) => visibleCost(s),
};

export function compareSessions(a, b, sort, dir) {
  const get = SORT_VALUE[sort] || SORT_VALUE.at;
  const va = get(a), vb = get(b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1; // missing always last, in both directions
  if (vb == null) return -1;
  const cmp = typeof va === "number" && typeof vb === "number"
    ? va - vb
    : String(va).localeCompare(String(vb));
  return dir === "desc" ? -cmp : cmp;
}

// --- Diagnose a slow run -------------------------------------------
// All helpers are pure and built only from recorded data. A line or
// series point appears only when its underlying data exists; nothing
// is estimated. `events` is the server shape (newest first, wire_ms
// plus gen_ai.usage.*); helpers normalise to oldest-first internally.

export function liveStateText(live) {
  if (!live || !live.state) return "";
  if (live.state === "retrying connection")
    return "Retrying connection" + (live.attempt ? " (attempt " + live.attempt + ")" : "");
  if (live.state === "waiting for approval")
    return "Waiting for approval" + (live.tool ? ": " + live.tool : "");
  if (live.state === "tool running")
    return "Tool running" + (live.tool ? ": " + live.tool : "");
  if (live.state === "model call running") return "Model call running";
  if (live.state === "ended") return "Ended";
  return "Idle";
}

export function explainLines({ wall_ms, model_ms, provider, events, split } = {}) {
  const lines = [];
  const chrono = [...(events || [])].reverse();
  if (wall_ms != null && model_ms != null && wall_ms > 0) {
    const share = Math.round((model_ms / wall_ms) * 100);
    const overhead = Math.max(0, wall_ms - model_ms);
    // A 51/49 split isn't domination. Only name a winner outside 40-60%.
    const dominated = share >= 40 && share <= 60 ? "Model and overhead were about even."
      : model_ms >= overhead ? "Model dominated." : "Overhead dominated.";
    lines.push("Model time was " + fmtDur(model_ms) + " of " + fmtDur(wall_ms)
      + " wall (" + share + "%). " + dominated);
  }
  const inputs = chrono.map((e) => e["gen_ai.usage.input_tokens"]);
  if (chrono.length >= 2 && inputs[0] != null && inputs[inputs.length - 1] != null) {
    const first = inputs[0];
    const last = inputs[inputs.length - 1];
    const growth = last - first;
    const sign = growth > 0 ? "+" : "";
    lines.push("Input tokens: " + fmt(first) + " on call 1 → " + fmt(last)
      + " on call " + chrono.length + " (" + sign + fmt(growth) + ").");
  }
  if (provider !== "claude-code") {
    let slowest = null;
    chrono.forEach((e, i) => {
      const w = e["wire_ms"];
      if (w != null && (slowest === null || w > slowest.wire)) {
        slowest = { n: i + 1, wire: w, input: e["gen_ai.usage.input_tokens"] };
      }
    });
    if (slowest) {
      lines.push("Slowest call was #" + slowest.n + " at " + fmtDur(slowest.wire)
        + " with " + fmt(slowest.input) + " input tokens.");
    }
  }
  const inSum = chrono.reduce((a, e) => a + (e["gen_ai.usage.input_tokens"] ?? 0), 0);
  const cacheSum = chrono.reduce((a, e) => a + (e["gen_ai.usage.cached_tokens"] ?? 0), 0);
  const hasCache = chrono.some((e) => e["gen_ai.usage.cached_tokens"] != null);
  if (hasCache && inSum > 0) {
    const pct = Math.round((cacheSum / inSum) * 100);
    lines.push("Cache covered " + fmt(cacheSum) + " of " + fmt(inSum)
      + " input tokens (" + pct + "%).");
  }
  chrono.forEach((e, i) => {
    const retries = e["retries"] || 0;
    const stalled = e["stalled_ms"];
    if (retries > 0 && stalled != null) {
      lines.push("Call " + (i + 1) + " retried "
        + (retries === 1 ? "once" : retries + " times")
        + " after the connection stalled for " + fmtDur(stalled) + ".");
    }
  });
  if (split && split.tool_ms != null && split.tool_ms > 0) {
    lines.push("Tools ran for " + fmtDur(split.tool_ms) + ".");
  }
  if (split && split.approval_ms != null && split.approval_ms > 0) {
    lines.push("Waited " + fmtDur(split.approval_ms) + " for approval.");
  }
  return lines;
}

export function usualBaseline(selected, sessions) {
  if (!selected) return null;
  const prompt = selected.prompt ?? "";
  const earlier = (sessions || []).filter((s) =>
    s.run_id !== selected.run_id
    && s.status === "completed"
    && (s.prompt ?? "") === prompt
    && s.provider === selected.provider
    && s.model === selected.model
    && (s.context_mode ?? "full") === (selected.context_mode ?? "full")
    && (!selected.at || !s.at || s.at < selected.at));
  if (earlier.length < 3) return null;
  return {
    count: earlier.length,
    wall_ms: median(earlier.map((s) => s.wall_ms)),
    model_ms: median(earlier.map((s) => s.model_ms)),
    overhead_ms: median(earlier.map((s) => s.overhead_ms)),
    input_tokens: median(earlier.map((s) => s.input_tokens)),
    output_tokens: median(earlier.map((s) => s.output_tokens)),
  };
}

// One assembly of the selected run's recorded facts. Overview, the
// run card and the repro pack all read this so the same run gets the
// same words everywhere. Mirrors what Overview used to inline.
export function selectedRunFacts(data) {
  const d = data || {};
  const sel = (d.sessions || []).find((s) => s.run_id === d.selected) || {};
  const events = d.events || [];
  const wires = events.map((e) => e["wire_ms"]).filter((v) => v != null);
  const hasEvents = events.length > 0;
  const modelTotal = hasEvents
    ? (d.model_ms ?? (wires.length ? wires.reduce((a, b) => a + b, 0) : null))
    : null;
  const wall = hasEvents ? (d.wall_ms ?? null) : null;
  const split = d.time_split || {};
  const provider = d.provider || sel.provider;
  const isRunning = (d.status || sel.status) === "running";
  const baseline = usualBaseline(sel.run_id ? sel : null, d.sessions || []);
  const whatLines = explainLines({
    wall_ms: wall, model_ms: modelTotal, provider, events, split,
  });
  const diag = !isRunning && hasEvents ? diagnoseRun({
    wall_ms: wall, model_ms: modelTotal, provider, events, split,
    timeline: d.timeline, baseline, intervals: d.intervals,
  }) : null;
  const detailLines = whatLines.filter((line) =>
    !line.startsWith("Model time was") && !line.startsWith("Tools ran")
    && !line.startsWith("Waited") && !line.includes(" retried "));
  return {
    sel, events, hasEvents, modelTotal, wall, split, provider,
    isRunning, baseline, whatLines, diag, detailLines,
  };
}

export function perCallSeries(events, provider) {
  if (provider === "claude-code") return [];
  const chrono = [...(events || [])].reverse();
  return chrono.map((e, i) => ({
    call: i + 1,
    model_ms: e["wire_ms"] ?? null,
    input_tokens: e["gen_ai.usage.input_tokens"] ?? null,
    cached_tokens: e["gen_ai.usage.cached_tokens"] ?? null,
    output_tokens: e["gen_ai.usage.output_tokens"] ?? null,
    retries: e["retries"] || 0,
    stalled_ms: e["stalled_ms"] ?? null,
  }));
}

// --- Replay ---------------------------------------------------------
// Pure playback maths over recorded timeline rows. Offsets come from
// each row's recorded timestamp. A row with no usable time is kept in
// `untimed` and never placed on the ruler. Counters at an offset sum
// only calls whose landing row is at or before that offset, and a
// landed call with a missing value makes that total null, not a
// part sum. A model bar start is derived: landing time minus the
// recorded model time. The view labels it as derived.

export function replayLabel(operation) {
  const op = String(operation || "");
  if (!op) return "–";
  if (op.includes("model_completed")) return "Model call landed";
  if (op.includes("model_request_configured")) return "Model call started";
  if (op.includes("user_intent.accepted")) return "Prompt accepted";
  if (op.includes("tool_batch.effect.started")) return "Tool started";
  if (op.includes("tool_batch.effect.terminal")) return "Tool finished";
  if (op.includes("approval_wait.effect.started")) return "Approval wait started";
  if (op.includes("approval_wait.effect.terminal")) return "Approval wait ended";
  if (op.includes("assistant_message_committed")) return "Reply committed";
  if (op.includes("session.end") || op.includes("session_end")) return "Session ended";
  return op;
}

function replayKind(operation, wireMs) {
  const op = String(operation || "");
  if (op.includes("model_completed") || wireMs != null) return "model";
  if (op.includes("approval")) return "approval";
  if (op.includes("tool")) return "tool";
  return "step";
}

export function replaySeries(timeline, events) {
  const rows = timeline || [];
  const timed = [];
  const untimed = [];
  rows.forEach((row, i) => {
    const atMs = row && row.at ? Date.parse(row.at) : NaN;
    const point = {
      index: i,
      at: (row && row.at) || null,
      operation: (row && row.operation) ?? null,
      label: replayLabel(row && row.operation),
      kind: replayKind(row && row.operation, row && row["wire_ms"]),
      wire_ms: (row && row["wire_ms"]) ?? null,
      duration_ms: (row && row.duration_ms) ?? null,
    };
    if (Number.isFinite(atMs)) timed.push({ ...point, atMs });
    else untimed.push(point);
  });
  timed.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  const t0 = timed.length ? timed[0].atMs : null;
  const points = timed.map((p) => {
    const offset_ms = p.atMs - t0;
    const { atMs, ...rest } = p;
    return {
      ...rest,
      offset_ms,
      model_start_ms: p.wire_ms != null ? offset_ms - p.wire_ms : null,
    };
  });
  const chrono = [...(events || [])].reverse();
  const landings = [];
  points.filter((p) => p.kind === "model").forEach((p, k) => {
    const ev = chrono[k] || {};
    landings.push({
      call: k + 1,
      offset_ms: p.offset_ms,
      model_ms: ev["wire_ms"] ?? p.wire_ms,
      model_start_ms: p.model_start_ms,
      input_tokens: ev["gen_ai.usage.input_tokens"] ?? null,
      output_tokens: ev["gen_ai.usage.output_tokens"] ?? null,
      cached_tokens: ev["gen_ai.usage.cached_tokens"] ?? null,
      retries: ev["retries"] || 0,
      stalled_ms: ev["stalled_ms"] ?? null,
    });
  });
  return {
    points,
    untimed,
    landings,
    span_ms: points.length ? points[points.length - 1].offset_ms : 0,
    start_at: points.length ? points[0].at : null,
    end_at: points.length ? points[points.length - 1].at : null,
  };
}

export function replayAt(series, offsetMs) {
  const s = series || { points: [], landings: [], span_ms: 0 };
  const t = Math.max(0, Math.min(offsetMs || 0, s.span_ms || 0));
  const landed = (s.landings || []).filter((l) => l.offset_ms <= t);
  const total = (key) => {
    if (!landed.length || landed.some((l) => l[key] == null)) return null;
    return landed.reduce((a, l) => a + l[key], 0);
  };
  const passed = (s.points || []).filter((p) => p.offset_ms <= t);
  const flying = (s.landings || []).find(
    (l) => l.model_start_ms != null && t >= l.model_start_ms && t < l.offset_ms);
  return {
    offset_ms: t,
    calls_landed: landed.length,
    input_tokens: total("input_tokens"),
    output_tokens: total("output_tokens"),
    model_ms: total("model_ms"),
    in_flight_call: flying ? flying.call : null,
    current: passed.length ? passed[passed.length - 1] : null,
    next: (s.points || []).find((p) => p.offset_ms > t) || null,
    passed_count: passed.length,
  };
}

// Two series under one shared clock. Span is the longer side.
// Offsets are the sorted union of both sides' step times, so
// stepping lands on the next event on either side. The start gap
// is the recorded second start minus the recorded first start.
// A missing start gives null, never an invented zero.
export function replayPair(a, b) {
  const points = [...((a && a.points) || []), ...((b && b.points) || [])];
  const offsets = [...new Set(points.map((p) => p.offset_ms))]
    .sort((x, y) => x - y);
  const startA = a && a.start_at ? Date.parse(a.start_at) : NaN;
  const startB = b && b.start_at ? Date.parse(b.start_at) : NaN;
  return {
    span_ms: Math.max((a && a.span_ms) || 0, (b && b.span_ms) || 0),
    offsets,
    gap_ms: Number.isFinite(startA) && Number.isFinite(startB)
      ? startB - startA : null,
  };
}

// --- Context X-ray ----------------------------------------------------
// Pure maths over recorded lane byte counts. Bytes stay bytes and are
// never converted to tokens. Raw groups fold by lane name. A folded
// lane with zero bytes stays out of the bars but its raw groups are
// counted. A lane absent from a step is null there, not an invented
// zero. Omitted groups make that step partial, flagged as such.

const XRAY_LANE_NAMES = {
  system_base: "System prompt",
  context: "Run context",
  history: "Conversation so far",
  tool_result: "Tool results",
  tool_specs: "Tool definitions",
  provider_options: "Provider options",
};

export function xrayLaneName(lane) {
  if (!lane) return "–";
  return XRAY_LANE_NAMES[lane] || lane;
}

export function xraySeries(xray) {
  const traces = xray || [];
  const steps = traces.map((t, i) => {
    const folded = new Map();
    let zeroGroups = 0;
    (t.lanes || []).forEach((g) => {
      if (g.bytes === 0) zeroGroups += 1;
      const key = g.lane || "–";
      if (!folded.has(key)) folded.set(key, { lane: key, bytes: 0, groups: [] });
      folded.get(key).bytes += g.bytes || 0;
      folded.get(key).groups.push(g);
    });
    return {
      call: i + 1,
      step: t.step ?? null,
      total_bytes: t.total_bytes ?? null,
      user_bytes: t.user_bytes ?? null,
      omitted_groups: t.omitted_groups ?? null,
      omitted_bytes: t.omitted_bytes ?? null,
      partial: Boolean(t.omitted_groups || t.omitted_bytes),
      zero_groups: zeroGroups,
      lanes: [...folded.values()].filter((l) => l.bytes > 0),
      folded,
    };
  });
  const laneOrder = [];
  steps.forEach((s) => s.lanes.forEach((l) => {
    if (!laneOrder.includes(l.lane)) laneOrder.push(l.lane);
  }));
  steps.forEach((s) => {
    s.byLane = {};
    laneOrder.forEach((lane) => {
      const hit = s.folded.get(lane);
      s.byLane[lane] = hit ? hit.bytes : null;
    });
    delete s.folded;
  });
  return { steps, laneOrder };
}

export function xrayFirstLanes(series, count) {
  const first = series && series.steps && series.steps[0];
  if (!first) return [];
  return [...first.lanes].sort((a, b) => b.bytes - a.bytes).slice(0, count || 2);
}

export function xrayHeadline(series) {
  const first = series && series.steps && series.steps[0];
  if (!first) return null;
  const total = first.total_bytes ?? null;
  const user = first.user_bytes ?? null;
  return {
    total_bytes: total,
    user_bytes: user,
    user_pct: total && user != null ? Math.round((user / total) * 10000) / 100 : null,
  };
}

export function xrayLines(series) {
  const lines = [];
  const steps = (series && series.steps) || [];
  if (steps.length < 2) {
    steps.forEach((s) => {
      if (s.partial) lines.push(partialLine(s));
    });
    return lines;
  }
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first.total_bytes != null && last.total_bytes != null
      && first.total_bytes !== last.total_bytes) {
    const diff = last.total_bytes - first.total_bytes;
    lines.push("Request size " + (diff > 0 ? "grew" : "shrank")
      + " from " + fmt(first.total_bytes) + " to " + fmt(last.total_bytes)
      + " bytes across " + steps.length + " calls ("
      + (diff > 0 ? "+" : "") + fmt(diff) + " bytes).");
  }
  (series.laneOrder || []).forEach((lane) => {
    const values = steps.map((s) => s.byLane[lane]);
    const name = xrayLaneName(lane);
    if (values.every((v) => v != null && v === values[0])) {
      lines.push(name + " held at " + fmt(values[0]) + " bytes on every call.");
      return;
    }
    const a = values[0];
    const b = values[values.length - 1];
    if (a != null && b != null && a !== b) {
      lines.push(name + (b > a ? " grew from " : " shrank from ")
        + fmt(a) + " to " + fmt(b) + " bytes.");
    }
  });
  steps.forEach((s) => {
    if (s.partial) lines.push(partialLine(s));
  });
  return lines;
}

function partialLine(step) {
  const groups = step.omitted_groups;
  const groupText = groups != null
    ? fmt(groups) + (groups === 1 ? " lane group was" : " lane groups were") + " omitted from the breakdown."
    : "Some lane groups were omitted from the breakdown.";
  const bytesText = step.omitted_bytes != null
    ? " Omitted lanes cover " + fmt(step.omitted_bytes) + " recorded bytes."
    : "";
  return "Call " + step.call + " breakdown is partial. " + groupText + bytesText
    + " The recorded total still stands.";
}

// --- Regression radar -----------------------------------------------
// Medians per prompt group and recorded harness version. Groups key
// on exact prompt text plus provider, model and context mode, the
// things a comparison holds constant. A group takes its suite name
// as the label when any run in it carries one, so runs recorded
// before the suite existed join their golden prompt instead of
// duplicating it. Versions group by their recorded
// string verbatim. Runs with no recorded version form their own
// column and never feed a delta. A delta needs RADAR_MIN_RUNS
// completed runs on both sides. Percent change is plain arithmetic
// on medians. Nothing here claims statistical significance.

export const RADAR_MIN_RUNS = 2;
const RADAR_NO_VERSION = "";

function radarDeltaMetric(from, to) {
  if (from == null || to == null) return { from, to, diff: null, pct: null };
  const diff = to - from;
  return {
    from, to, diff,
    pct: from ? Math.round((diff / from) * 1000) / 10 : null,
  };
}

export function radarMatrix(sessions) {
  const done = (sessions || []).filter((s) => s.status === "completed");
  const versionFirstSeen = new Map();
  done.forEach((s) => {
    const v = s.harness_version || RADAR_NO_VERSION;
    const at = s.at || "";
    if (!versionFirstSeen.has(v) || at < versionFirstSeen.get(v)) {
      versionFirstSeen.set(v, at);
    }
  });
  const recorded = [...versionFirstSeen.keys()]
    .filter((v) => v !== RADAR_NO_VERSION)
    .sort((a, b) => String(versionFirstSeen.get(a)).localeCompare(
      String(versionFirstSeen.get(b))) || a.localeCompare(b));
  const versions = [
    ...(versionFirstSeen.has(RADAR_NO_VERSION)
      ? [{ key: RADAR_NO_VERSION, label: "Version not recorded", recorded: false }]
      : []),
    ...recorded.map((v) => ({ key: v, label: v, recorded: true })),
  ];

  const groups = new Map();
  done.forEach((s) => {
    const key = [s.prompt || s.run_id || "?", s.provider || "?",
      s.model || "?", s.context_mode || "?"].join("\n");
    if (!groups.has(key)) {
      groups.set(key, {
        key, label: s.suite_prompt || s.prompt || s.run_id || "?",
        suite: Boolean(s.suite_prompt), prompt: s.prompt || "",
        provider: s.provider || "?", model: s.model || "?",
        context_mode: s.context_mode || "?",
        runsByVersion: new Map(), total: 0,
      });
    }
    const g = groups.get(key);
    if (s.suite_prompt && !g.suite) {
      g.label = s.suite_prompt;
      g.suite = true;
    }
    const v = s.harness_version || RADAR_NO_VERSION;
    if (!g.runsByVersion.has(v)) g.runsByVersion.set(v, []);
    g.runsByVersion.get(v).push(s);
    g.total += 1;
  });

  const rows = [...groups.values()].map((g) => {
    const cells = {};
    g.runsByVersion.forEach((runs, v) => {
      cells[v] = {
        n: runs.length,
        wall_ms: median(runs.map((r) => r.wall_ms)),
        model_ms: median(runs.map((r) => r.model_ms)),
        input_tokens: median(runs.map((r) => r.input_tokens)),
      };
    });
    const eligible = recorded.filter(
      (v) => cells[v] && cells[v].n >= RADAR_MIN_RUNS);
    let delta = null;
    if (eligible.length >= 2) {
      const fromV = eligible[eligible.length - 2];
      const toV = eligible[eligible.length - 1];
      delta = {
        from_version: fromV, to_version: toV,
        wall_ms: radarDeltaMetric(cells[fromV].wall_ms, cells[toV].wall_ms),
        model_ms: radarDeltaMetric(cells[fromV].model_ms, cells[toV].model_ms),
        input_tokens: radarDeltaMetric(
          cells[fromV].input_tokens, cells[toV].input_tokens),
      };
    }
    const { runsByVersion, ...rest } = g;
    return { ...rest, cells, delta };
  });
  rows.sort((a, b) => Number(b.suite) - Number(a.suite)
    || b.total - a.total || a.label.localeCompare(b.label));
  return { versions, rows };
}

function radarPctText(pct) {
  if (pct == null) return "–";
  const body = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return (pct > 0 ? "+" : "") + body + "%";
}

export function radarReport(matrix, generatedAt) {
  const m = matrix || { versions: [], rows: [] };
  const date = String(generatedAt || "").slice(0, 10) || "–";
  const withDelta = m.rows.filter((r) => r.delta);
  const compared = withDelta.length
    ? [...new Set(withDelta.flatMap(
        (r) => [r.delta.from_version, r.delta.to_version]))]
    : [];
  const lines = [
    "# Muse latency report: regression radar",
    "",
    "Date: " + date,
    "Reporter: (fill in)",
    "Versions compared: " + (compared.length ? compared.join(" -> ") : "none yet"),
    "",
    "Generated by meta-benchmark regression radar from local recorded runs. "
      + "Every number below is a median of recorded runs. Nothing is estimated.",
    "",
    "## Summary",
    "",
  ];
  if (withDelta.length) {
    withDelta.forEach((r) => {
      const d = r.delta.wall_ms;
      lines.push("- " + r.label + ": median wall " + fmtMs(d.from) + " ms -> "
        + fmtMs(d.to) + " ms (" + radarPctText(d.pct) + ") between "
        + r.delta.from_version + " (" + r.cells[r.delta.from_version].n
        + " runs) and " + r.delta.to_version + " ("
        + r.cells[r.delta.to_version].n + " runs).");
    });
  } else {
    lines.push("No prompt has two versions with at least " + RADAR_MIN_RUNS
      + " completed runs each yet. Run ./run-muse --suite under a second "
      + "version to fill this in.");
  }
  lines.push("", "## Medians by prompt and version", "");
  lines.push("| Prompt | Provider/model | Version | Runs | Wall | Model | Input tokens |");
  lines.push("|---|---|---|---|---|---|---|");
  m.rows.forEach((r) => {
    m.versions.forEach((v) => {
      const cell = r.cells[v.key];
      if (!cell) return;
      lines.push("| " + r.label + " | " + r.provider + "/" + r.model
        + " | " + v.label + " | " + cell.n + " | " + fmtDur(cell.wall_ms)
        + " | " + fmtDur(cell.model_ms) + " | "
        + fmt(cell.input_tokens == null ? null : Math.round(cell.input_tokens)) + " |");
    });
  });
  lines.push(
    "",
    "## Method",
    "",
    "Runs were recorded locally by meta-benchmark. Medians cover completed "
      + "runs only. Within a row, prompt text, provider, model and context "
      + "mode are held constant. Not held constant: machine load, network "
      + "conditions and time of day. A delta needs at least "
      + RADAR_MIN_RUNS + " completed runs on each side. Percent change is "
      + "plain arithmetic on the two medians. No significance test is claimed.",
    "");
  return lines.join("\n");
}

// --- Why was this slow ----------------------------------------------
// Two tiers, because causes nest. Tier 1 buckets are the recorded
// time split: non-overlapping shares of wall. Tier 2 findings are
// observations that explain a bucket and say which one they sit in
// where nesting applies. Thresholds below only choose what surfaces.
// Every number in a finding is recorded or plain arithmetic on
// recorded numbers. Findings with recorded milliseconds rank by
// those milliseconds. The rest follow in fixed priority order.

const DIAG_APPROVAL_MIN_MS = 1000;
const DIAG_MUSE_MIN_SHARE = 0.25;
const DIAG_DOMINANT_MIN_CALLS = 3;
const DIAG_DOMINANT_SHARE = 0.5;
const DIAG_GROWTH_RATIO = 2;
const DIAG_GROWTH_MIN_TOKENS = 5000;
const DIAG_CACHE_MIN_CALLS = 3;
const DIAG_CACHE_MAX_PCT = 25;
const DIAG_FIXED_MIN_TOKENS = 20000;
const DIAG_USUAL_MIN_PCT = 25;
const DIAG_USUAL_MIN_MS = 2000;
const DIAG_MAX_FINDINGS = 6;
const DIAG_TOOL_MIN_MS = 1000;
const DIAG_TOOL_MIN_SHARE = 0.05;

const DIAG_BUCKET_LABELS = {
  model: "model time",
  tools: "tools",
  approval: "approval wait",
  muse: "Muse overhead",
};

export function toolTotals(intervalsData) {
  const list = (intervalsData && intervalsData.intervals)
    || (Array.isArray(intervalsData) ? intervalsData : []);
  const byName = new Map();
  list.filter((iv) => iv.kind === "tool").forEach((iv) => {
    const name = iv.name || "unnamed tool";
    if (!byName.has(name)) {
      byName.set(name, {
        name, total_ms: 0, wait_ms: 0, calls: 0,
        slowest_ms: null, slowest_start_at: null,
      });
    }
    const g = byName.get(name);
    g.total_ms += iv.duration_ms || 0;
    g.wait_ms += iv.wait_ms || 0;
    g.calls += 1;
    if (g.slowest_ms == null || (iv.duration_ms || 0) > g.slowest_ms) {
      g.slowest_ms = iv.duration_ms ?? null;
      g.slowest_start_at = iv.start_at || null;
    }
  });
  return [...byName.values()].sort((a, b) => b.total_ms - a.total_ms);
}

export function parseReplayStart(value, spanMs) {
  const span = spanMs || 0;
  if (!span) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, span);
}

export function diagnoseRun({ wall_ms, model_ms, provider, events, split, timeline, baseline, intervals } = {}) {
  const wall = wall_ms ?? null;
  const chrono = [...(events || [])].reverse();
  const series = replaySeries(timeline, events);
  const landingOffset = (call) => {
    const hit = series.landings[call - 1];
    return hit ? hit.offset_ms : null;
  };
  const shareOf = (ms) => (ms != null && wall ? Math.round((ms / wall) * 100) : null);

  const bucketDefs = [
    ["model", split && split.model_ms != null ? split.model_ms : (model_ms ?? null)],
    ["tools", split ? (split.tool_ms ?? null) : null],
    ["approval", split ? (split.approval_ms ?? null) : null],
    ["muse", split ? (split.muse_ms ?? null) : null],
  ];
  const buckets = bucketDefs
    .map(([key, ms]) => ({ key, label: DIAG_BUCKET_LABELS[key], ms, share_pct: shareOf(ms) }))
    .sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));
  const top = buckets[0];
  let verdict = null;
  if (top && top.ms != null && top.share_pct != null) {
    verdict = top.share_pct >= 50
      ? "Most of this run was " + top.label + " (" + top.share_pct + "% of wall)."
      : "No single slice dominated. The biggest was " + top.label
        + " at " + top.share_pct + "% of wall.";
  }

  const withMs = [];
  const withoutMs = [];
  const wires = chrono.map((e) => e["wire_ms"] ?? null);
  const wireTotal = wires.reduce((a, w) => a + (w || 0), 0);

  chrono.forEach((e, i) => {
    const stalled = e["stalled_ms"];
    const retries = e["retries"] || 0;
    if (retries > 0 && stalled != null && stalled > 0) {
      const pct = shareOf(stalled);
      withMs.push({
        kind: "stalled", ms: stalled, call: i + 1,
        replay_offset_ms: landingOffset(i + 1),
        text: "Call " + (i + 1) + " stalled for " + fmtDur(stalled)
          + (retries === 1 ? " before a retry." : " across " + retries + " retries.")
          + (pct != null ? " That is " + pct + "% of wall, inside model time." : ""),
      });
    }
  });

  const intervalList = (intervals && intervals.intervals) || [];
  const intervalOffset = (startAt) => {
    if (!startAt || !series.start_at) return null;
    const off = Date.parse(startAt) - Date.parse(series.start_at);
    return Number.isFinite(off) ? Math.max(0, off) : null;
  };
  const topTool = toolTotals(intervals)[0] || null;
  if (topTool && wall && topTool.total_ms >= DIAG_TOOL_MIN_MS
      && topTool.total_ms / wall >= DIAG_TOOL_MIN_SHARE) {
    withMs.push({
      kind: "slowest-tool", ms: topTool.total_ms, call: null,
      replay_offset_ms: intervalOffset(topTool.slowest_start_at),
      text: topTool.name + " took " + fmtDur(topTool.total_ms)
        + " across " + topTool.calls + (topTool.calls === 1 ? " call" : " calls")
        + " (" + shareOf(topTool.total_ms) + "% of wall)."
        + (topTool.calls > 1 && topTool.slowest_ms != null
          ? " Slowest single " + topTool.name + " ran " + fmtDur(topTool.slowest_ms) + "."
          : "")
        + (topTool.wait_ms > 0
          ? " Approval wait inside those calls adds up to " + fmtDur(topTool.wait_ms) + "."
          : ""),
    });
  }

  if (split && split.approval_ms != null && split.approval_ms >= DIAG_APPROVAL_MIN_MS) {
    const firstApproval = series.points.find((p) => p.kind === "approval");
    const approvalNames = [...new Set(intervalList
      .filter((iv) => iv.kind === "approval" && iv.name)
      .map((iv) => iv.name))];
    const approvalLabel = approvalNames.length === 1
      ? "Approval wait for " + approvalNames[0] : "Approval wait";
    withMs.push({
      kind: "approval", ms: split.approval_ms, call: null,
      replay_offset_ms: firstApproval ? firstApproval.offset_ms : null,
      text: approvalLabel + " took " + fmtDur(split.approval_ms)
        + (shareOf(split.approval_ms) != null
          ? " (" + shareOf(split.approval_ms) + "% of wall)." : "."),
    });
  }

  if (split && split.muse_ms != null && wall
      && split.muse_ms / wall >= DIAG_MUSE_MIN_SHARE) {
    withMs.push({
      kind: "muse-overhead", ms: split.muse_ms, call: null,
      replay_offset_ms: null,
      text: "Muse overhead took " + fmtDur(split.muse_ms)
        + " (" + shareOf(split.muse_ms) + "% of wall). That is everything "
        + "recorded outside model time, tools and approval wait.",
    });
  }

  if (provider !== "claude-code" && chrono.length >= DIAG_DOMINANT_MIN_CALLS
      && wireTotal > 0) {
    let slowest = null;
    wires.forEach((w, i) => {
      if (w != null && (!slowest || w > slowest.ms)) slowest = { ms: w, call: i + 1 };
    });
    if (slowest && slowest.ms / wireTotal >= DIAG_DOMINANT_SHARE) {
      withMs.push({
        kind: "dominant-call", ms: slowest.ms, call: slowest.call,
        replay_offset_ms: landingOffset(slowest.call),
        text: "Call " + slowest.call + " took " + fmtDur(slowest.ms) + " of "
          + fmtDur(wireTotal) + " model time ("
          + Math.round((slowest.ms / wireTotal) * 100) + "%). One call carried the run.",
      });
    }
  }

  if (baseline && baseline.wall_ms != null && wall != null) {
    const diff = wall - baseline.wall_ms;
    const pct = baseline.wall_ms ? (diff / baseline.wall_ms) * 100 : null;
    if (diff >= DIAG_USUAL_MIN_MS && pct != null && pct >= DIAG_USUAL_MIN_PCT) {
      withoutMs.push({
        kind: "slower-than-usual", ms: null, call: null, replay_offset_ms: null,
        text: "Wall " + fmtDur(wall) + " against a usual " + fmtDur(baseline.wall_ms)
          + " for this prompt (median of " + baseline.count + " earlier runs, +"
          + Math.round(pct) + "%).",
      });
    }
  }

  const inputs = chrono.map((e) => e["gen_ai.usage.input_tokens"] ?? null);
  if (chrono.length >= 2 && inputs[0] && inputs[inputs.length - 1] != null) {
    const first = inputs[0];
    const last = inputs[inputs.length - 1];
    if (last / first >= DIAG_GROWTH_RATIO && last - first >= DIAG_GROWTH_MIN_TOKENS) {
      withoutMs.push({
        kind: "context-growth", ms: null, call: chrono.length,
        replay_offset_ms: landingOffset(chrono.length),
        text: "Input grew from " + fmt(first) + " tokens on call 1 to " + fmt(last)
          + " on call " + chrono.length + " ("
          + (Math.round((last / first) * 10) / 10) + "x). Later calls reprocess the whole history.",
      });
    }
  }

  if (chrono.length && inputs[0] != null && inputs[0] >= DIAG_FIXED_MIN_TOKENS) {
    const out = chrono[0]["gen_ai.usage.output_tokens"];
    withoutMs.push({
      kind: "fixed-context", ms: null, call: 1,
      replay_offset_ms: landingOffset(1),
      text: "Call 1 already carried " + fmt(inputs[0]) + " input tokens"
        + (out != null ? ". Its recorded output was " + fmt(out) + " tokens" : "")
        + ". Most of a first call is fixed context Muse sends every time.",
    });
  }

  const hasCache = chrono.some((e) => e["gen_ai.usage.cached_tokens"] != null);
  const inSum = inputs.reduce((a, n) => a + (n || 0), 0);
  const cacheSum = chrono.reduce(
    (a, e) => a + (e["gen_ai.usage.cached_tokens"] || 0), 0);
  if (hasCache && chrono.length >= DIAG_CACHE_MIN_CALLS && inSum > 0) {
    const pct = Math.round((cacheSum / inSum) * 100);
    if (pct < DIAG_CACHE_MAX_PCT) {
      withoutMs.push({
        kind: "weak-cache", ms: null, call: null, replay_offset_ms: null,
        text: "Cache covered only " + pct + "% of " + fmt(inSum)
          + " input tokens across " + chrono.length
          + " calls. Most context was processed fresh each call.",
      });
    }
  }

  withMs.sort((a, b) => b.ms - a.ms);
  const findings = [...withMs, ...withoutMs].slice(0, DIAG_MAX_FINDINGS);
  const unclosed = [
    ...((intervals && intervals.unclosed_tools) || []),
    ...((intervals && intervals.unclosed_approvals) || []),
  ];
  const unclosedNames = [...new Set(unclosed)];
  const partial_note = unclosedNames.length
    ? "Tool picture is partial: " + unclosedNames.join(", ")
      + " started but never recorded a finish, so "
      + (unclosedNames.length === 1 ? "it is" : "they are")
      + " not counted or drawn."
    : null;
  return { buckets, verdict, findings, partial_note };
}

export function dataSignature(d) {
  return JSON.stringify([d.selected, d.status,
    (d.sessions || []).map((s) => [s.run_id, s.status, s.wall_ms, s.calls]),
    (d.events || []).length, (d.timeline || []).length, d.reply || "", d.wall_ms]);
}

// --- Shareable run cards and repro packs -----------------------------
// Both artifacts are Markdown built only from the /api/logs payload,
// which carries no absolute paths and no stored command string. The
// prompt and reply are user content shared on purpose. A missing
// number is always a dash, never an estimate.

export const CARD_PROMPT_CHARS = 200;
export const PACK_TIMELINE_ROWS = 200;

// Fence that always outranks any backtick run inside the text, so
// prompt or reply content can never break the surrounding Markdown.
function mdFence(text) {
  const t = String(text ?? "");
  const runs = t.match(/`+/g) || [];
  const longest = runs.reduce((a, r) => Math.max(a, r.length), 0);
  const mark = "`".repeat(Math.max(3, longest + 1));
  return mark + "\n" + t + "\n" + mark;
}

const capLine = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function runCard(data) {
  const d = data || {};
  const f = selectedRunFacts(d);
  const sel = f.sel;
  const runId = d.selected || sel.run_id || null;
  if (!runId) return "# Run card\n\nNo run selected.\n";
  const prompt = String(d.prompt ?? sel.prompt ?? "");
  const truncated = prompt.length > CARD_PROMPT_CHARS;
  const shownPrompt = truncated ? prompt.slice(0, CARD_PROMPT_CHARS) : prompt;
  const status = d.status || sel.status || "unknown";
  const usual = f.baseline && f.baseline.wall_ms != null
    ? " (usual " + fmtDur(f.baseline.wall_ms) + " across "
      + f.baseline.count + " earlier runs)"
    : "";
  const lines = [
    "# Run card: " + runId,
    "",
    "Prompt:",
    "",
    mdFence(shownPrompt || "–"),
  ];
  if (truncated) {
    lines.push("", "Prompt truncated at " + CARD_PROMPT_CHARS
      + " characters on this card. The repro pack carries it in full.");
  }
  lines.push(
    "",
    "- When: " + (localTime(sel.at) || "–"),
    "- Status: " + status,
    "- Provider and model: " + legKey({
      provider: d.provider || sel.provider,
      model: d.model || sel.model,
    }),
    "- Harness: " + (sel.harness_version ?? d.harness_version ?? "–"),
    "- Context: " + (sel.context_mode ?? "–"),
    "- Wall time: " + fmtDur(f.wall) + usual,
    "- Model time: " + fmtDur(f.modelTotal)
      + " · Tools: " + fmtDur(f.split.tool_ms ?? null)
      + " · Approval wait: " + fmtDur(f.split.approval_ms ?? null)
      + " · Muse: " + fmtDur(f.split.muse_ms ?? null),
    "- Calls: " + fmt(f.hasEvents ? f.events.length : (sel.calls ?? null))
      + " · Input tokens: " + fmt(sel.input_tokens ?? null)
      + " · Output tokens: " + fmt(sel.output_tokens ?? null),
    "- Cost: " + fmtCost(visibleCost(sel))
      + (visibleCost(sel) == null ? "" : " (" + costNote(sel) + ")"),
    "",
  );
  if (f.isRunning) {
    lines.push("Run in progress. Totals grow as calls land.");
  } else if (!f.hasEvents) {
    lines.push("No calls were recorded for this run.");
  } else if (f.diag) {
    if (f.diag.verdict) lines.push("Verdict: " + f.diag.verdict, "");
    lines.push("Where the wall time went:");
    f.diag.buckets.forEach((b) => {
      lines.push("- " + capLine(b.label) + ": "
        + (b.ms == null ? "–" : fmtDur(b.ms) + " · " + b.share_pct + "%"));
    });
    lines.push("");
    if (f.diag.findings.length) {
      lines.push("Why it was slow, ranked:");
      f.diag.findings.forEach((finding, i) => {
        lines.push((i + 1) + ". " + finding.text);
      });
    } else {
      lines.push("No recorded cause stands out. "
        + "The slices above are the whole story the log tells.");
    }
    if (f.diag.partial_note) lines.push("", f.diag.partial_note);
    if (f.detailLines.length) {
      lines.push("", "What happened:");
      f.detailLines.forEach((line) => lines.push("- " + line));
    }
  } else if (f.whatLines.length) {
    lines.push("What happened:");
    f.whatLines.forEach((line) => lines.push("- " + line));
  }
  lines.push(
    "",
    "Recorded data only. Nothing is estimated. "
      + "Generated by meta-benchmark from a local run log.",
    "",
  );
  return lines.join("\n");
}

// One-line, shell-safe form of the prompt for the rerun command.
// The prompt itself always rides in full above the command.
function shellPrompt(prompt) {
  const flat = String(prompt ?? "").replace(/\s+/g, " ").trim();
  return flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

const cell = (v) => String(v ?? "–").replace(/\|/g, "/");

export function reproPack(data) {
  const d = data || {};
  const f = selectedRunFacts(d);
  const sel = f.sel;
  const runId = d.selected || sel.run_id || null;
  if (!runId) return "# Repro pack\n\nNo run selected.\n";
  const prompt = String(d.prompt ?? sel.prompt ?? "");
  const reply = String(d.reply ?? "");
  const cardBody = runCard(d).replace(/^# Run card: [^\n]*\n\n/, "");
  const lines = [
    "# Repro pack: " + runId,
    "",
    "Everything recorded about one local run, in one file. "
      + "Recorded data only. Nothing is estimated.",
    "",
    "## Run card",
    "",
    cardBody.trimEnd(),
    "",
    "## Prompt in full",
    "",
    mdFence(prompt || "–"),
    "",
    "## Rerun it",
    "",
  ];
  const provider = d.provider || sel.provider || null;
  const model = d.model || sel.model || null;
  const context = sel.context_mode ?? null;
  const harness = sel.harness_version ?? d.harness_version ?? null;
  lines.push("Recorded setup: provider " + (provider || "–")
    + ", model " + (model || "–")
    + ", context " + (context || "–")
    + ", harness " + (harness || "–") + ".");
  if (sel.suite_id) {
    lines.push("This run was part of suite " + sel.suite_id
      + (sel.suite_prompt ? " (prompt " + sel.suite_prompt + ")" : "") + ".");
  }
  if (sel.comparison_id) {
    lines.push("This run was part of compare set " + sel.comparison_id
      + (sel.round ? ", round " + sel.round : "") + ".");
  }
  lines.push("");
  if (context === "interactive") {
    lines.push("This run came from a watched interactive session. "
      + "There is no one-command rerun for it. "
      + "The prompt and every recorded number are in this pack.");
  } else {
    const parts = ["./run-muse"];
    if (provider) parts.push("--provider " + provider);
    if (model) parts.push("--model " + model);
    if (context === "minimal") parts.push("--minimal");
    parts.push('"' + shellPrompt(prompt) + '"');
    lines.push("    " + parts.join(" "), "");
    lines.push("Timing will differ on a rerun. "
      + "Machine load and network conditions are not held constant.");
  }
  lines.push("", "## Reply", "");
  lines.push(reply ? mdFence(reply) : "No reply recorded for this run.");
  if (f.hasEvents) {
    const chrono = [...f.events].reverse();
    lines.push("", "## Per-call detail", "",
      "| Call | Model | Model time | Input | Output | Cached | Reasoning | Retries | Stalled |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    chrono.forEach((e, i) => {
      lines.push("| " + [
        i + 1,
        cell(e.model || model),
        fmtDur(e["wire_ms"] ?? null),
        fmt(e["gen_ai.usage.input_tokens"] ?? null),
        fmt(e["gen_ai.usage.output_tokens"] ?? null),
        fmt(e["gen_ai.usage.cached_tokens"] ?? null),
        fmt(e["gen_ai.usage.reasoning_tokens"] ?? null),
        fmt(e["retries"] || 0),
        fmtDur(e["stalled_ms"] ?? null),
      ].join(" | ") + " |");
    });
  }
  const series = xraySeries(d.xray || []);
  const head = xrayHeadline(series);
  if (head && head.total_bytes != null) {
    lines.push("", "## Context X-ray", "");
    lines.push("The first recorded request was " + fmt(head.total_bytes)
      + " bytes. The user message was " + fmt(head.user_bytes) + " bytes.");
    const lanes = xrayFirstLanes(series, 3)
      .filter((l) => l.bytes != null);
    if (lanes.length) {
      lines.push("Biggest first-request lanes: "
        + lanes.map((l) => xrayLaneName(l.lane) + " " + fmt(l.bytes) + " bytes").join(", ")
        + ".");
    }
    xrayLines(series).forEach((line) => lines.push("- " + line));
  }
  const totals = toolTotals(d.intervals);
  const unclosed = [...new Set([
    ...((d.intervals && d.intervals.unclosed_tools) || []),
    ...((d.intervals && d.intervals.unclosed_approvals) || []),
  ])];
  if (totals.length || unclosed.length) {
    lines.push("", "## Tools", "");
    totals.forEach((t) => {
      lines.push("- " + t.name + ": " + t.calls
        + (t.calls === 1 ? " call" : " calls")
        + " · " + fmtDur(t.total_ms) + " total"
        + " · slowest " + fmtDur(t.slowest_ms)
        + (t.wait_ms > 0 ? " · approval wait inside " + fmtDur(t.wait_ms) : ""));
    });
    if (unclosed.length) {
      lines.push("- Tool picture is partial: " + unclosed.join(", ")
        + " started but never recorded a finish, so "
        + (unclosed.length === 1 ? "it is" : "they are")
        + " not counted above.");
    }
  }
  if ((d.errors || []).length) {
    lines.push("", "## Errors", "");
    d.errors.forEach((e) => {
      lines.push("- " + (e.operation || "call") + ": " + (e.error_type || "failed"));
    });
  }
  const timeline = d.timeline || [];
  if (timeline.length) {
    lines.push("", "## Timeline", "",
      "| # | Operation | Duration | Wire |",
      "| --- | --- | --- | --- |");
    timeline.slice(0, PACK_TIMELINE_ROWS).forEach((t, i) => {
      lines.push("| " + [
        i + 1,
        cell(t.operation),
        fmtDur(t.duration_ms ?? null),
        fmtDur(t.wire_ms ?? null),
      ].join(" | ") + " |");
    });
    if (timeline.length > PACK_TIMELINE_ROWS) {
      lines.push("", "Timeline truncated at " + PACK_TIMELINE_ROWS
        + " of " + timeline.length + " rows in this pack.");
    }
  }
  lines.push("");
  return lines.join("\n");
}
