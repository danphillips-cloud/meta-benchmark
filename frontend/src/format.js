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
  // Subscription and echo runs never show USD, even an old record
  // that stored a cost at the user's rates.
  if (costUnit(s) !== "usd") return null;
  if (String(s.model || "").startsWith("muse-")
    && s.cost_source !== "computed" && s.cost_source !== "list") return null;
  return s.cost_usd;
};

export const fmtCost = (n) => (n == null ? "–" : "$" + Number(n).toFixed(4));

export const costNote = (s) => {
  if (!s || s.cost_usd == null) return "not recorded";
  if (costUnit(s) !== "usd") return "not billed in USD";
  if (visibleCost(s) == null) return "not a Meta price, hidden";
  if (s.cost_source === "computed") return "at your rates";
  if (s.cost_source === "list") return "at Meta list";
  return "reported";
};

// The unit a run is billed in. Paid paths bill USD. Muse paths
// bill subscription allowance. Echo bills nothing.
export const costUnit = (s) => {
  if (!s) return "usd";
  if (s.provider === "anthropic" || s.provider === "claude-code") return "usd";
  if (s.provider === "echo") return "none";
  return "allowance";
};

const fmtMovedPct = (v, equal) => {
  if (v == null) return "–";
  // Equal whole-percent readings mean the limit moved less than
  // one point. Say exactly that, never "+0%".
  if (v === 0 && equal) return "under 1%";
  return "+" + v + "%";
};

// Recorded plan usage movement, or a dash when neither limit moved
// on record. A missing limit dashes on its own. Plain labels only.
// The short-term limit's length is never stated. It is not recorded.
// `equal` marks limits whose start and end readings match.
export const fmtAllowance = (delta, equal) => {
  if (!delta || (delta.window == null && delta.weekly == null)) return "–";
  const eq = equal || {};
  return fmtMovedPct(delta.window, eq.window) + " short-term"
    + " · " + fmtMovedPct(delta.weekly, eq.weekly) + " weekly";
};

const allowanceEqual = (s) => {
  const start = (s && s.allowance_start) || {};
  const end = (s && s.allowance_end) || {};
  const eq = (key) => !!(start[key] && end[key]
    && start[key].used_percent === end[key].used_percent);
  return { window: eq("window"), weekly: eq("weekly") };
};

// A recorded reset instant as a local clock time, like "4:12 pm".
export const fmtResetClock = (ms) => {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\s+/g, " ").toLowerCase();
};

// One-cell cost display in the run's billed unit. A recorded USD
// figure wins, then allowance, then a dash.
export const runCostText = (s) => {
  const usd = visibleCost(s);
  if (usd != null) return fmtCost(usd);
  if (costUnit(s) === "allowance") return fmtAllowance(s.allowance_delta, allowanceEqual(s));
  return "–";
};

// The two Overview mini-table rows, from recorded readings only.
// A missing limit's row carries a dash and its reason.
export const allowanceRows = (s) => {
  const d = (s && s.allowance_delta) || {};
  const start = (s && s.allowance_start) || {};
  const end = (s && s.allowance_end) || {};
  const row = (key, label, withReset) => {
    const before = start[key] ? start[key].used_percent : null;
    const after = end[key] ? end[key].used_percent : null;
    if (d[key] == null || before == null || after == null) {
      return { label, range: "–", moved: "–", resets: null, reason: costReason(s, key) };
    }
    return {
      label,
      range: before + "% → " + after + "%",
      moved: d[key] === 0 ? "under 1%" : "+" + d[key] + "%",
      resets: withReset ? fmtResetClock(end[key].resets_at_ms) : null,
      reason: null,
    };
  };
  return [row("window", "Short-term limit", true),
    row("weekly", "Weekly limit", false)];
};

// Overview Cost card big value for allowance runs: the short-term
// movement only, in the same shape as the other cards (number big,
// unit small). Weekly stands in when short-term is missing.
export const allowanceBig = (s) => {
  const d = s && s.allowance_delta;
  if (!d) return null;
  const eq = allowanceEqual(s);
  if (d.window != null) return { value: fmtMovedPct(d.window, eq.window), unit: "short-term" };
  if (d.weekly != null) return { value: fmtMovedPct(d.weekly, eq.weekly), unit: "weekly" };
  return null;
};

// Overview Cost card detail line for allowance runs: the limit
// that is not in the big value, plus the short-term reset time.
export const allowanceDetail = (s) => {
  const d = s && s.allowance_delta;
  if (!d) return "";
  const bigKey = d.window != null ? "window" : d.weekly != null ? "weekly" : null;
  if (!bigKey) return "";
  const otherKey = bigKey === "window" ? "weekly" : "window";
  const label = otherKey === "window" ? "Short-term" : "Weekly";
  if (d[otherKey] == null) return label + " – · " + costReason(s, otherKey);
  let text = label + " " + fmtMovedPct(d[otherKey], allowanceEqual(s)[otherKey]);
  const end = (s.allowance_end || {}).window;
  const clock = end ? fmtResetClock(end.resets_at_ms) : null;
  if (clock) text += " · short-term resets " + clock;
  return text;
};

// The short explanation lines behind the "Details" button.
export const allowanceInfoLines = (s) => {
  const lines = [
    "Your Muse plan has a short-term limit and a weekly limit.",
    "These show how far each moved while this run ran.",
    "The muse usage command calls the short-term one Window.",
    "Other Muse use at the same time counts too.",
  ];
  if (s && s.raced) {
    lines.push("Legs ran at the same time, so their movements overlap.");
  }
  return lines;
};

// Runs hover text: the two table rows as two lines, then the notes.
export const allowanceHoverText = (s) => {
  const rows = allowanceRows(s).map((r) => (r.reason
    ? r.label + ": – (" + r.reason + ")"
    : r.label + ": " + r.range + " · " + r.moved
      + (r.resets ? " · resets " + r.resets : "")));
  const notes = ["Other Muse use at the same time counts too."];
  if (s && s.raced) {
    notes.push("Legs ran at the same time, so their movements overlap.");
  }
  return [...rows, ...notes].join("\n");
};

// Info panel state machine, kept pure so it can be tested without
// a DOM. Open on hover, pinned by click, closed by Escape,
// outside click, or focus leaving the wrapper.
export const infoPanelOpen = (state) => !!(state && (state.pinned || state.hover));

export const infoPanelNext = (state, event) => {
  const st = state || { pinned: false, hover: false };
  switch (event) {
    case "hover-in": return { ...st, hover: true };
    case "hover-out": return { ...st, hover: false };
    // A click pins the panel, even one already open by hover. A
    // click on a pinned panel closes it fully, hover included. A tap
    // fires hover-in then click, so tap-tap opens then closes.
    case "click": return st.pinned
      ? { pinned: false, hover: false }
      : { ...st, pinned: true };
    case "escape":
    case "outside":
    case "blur-out": return { pinned: false, hover: false };
    default: return st;
  }
};

// Runs copied-summary plan usage total. Each limit sums only over
// runs that recorded it, and says how many that was. Never a
// missing reading dressed as 0 inside a sum. A zero total over
// real readings prints "+0%": it is a sum, not one reading pair.
// Raced runs stay out so overlapping legs never double count.
export const planUsageTotalText = (sessions) => {
  const hasDelta = (s) => s.allowance_delta
    && (s.allowance_delta.window != null || s.allowance_delta.weekly != null);
  const included = (sessions || []).filter((s) => hasDelta(s) && !s.raced);
  const racedOut = (sessions || []).filter((s) => hasDelta(s) && s.raced).length;
  const bucket = (key, label) => {
    const values = included
      .map((s) => s.allowance_delta[key])
      .filter((v) => v != null);
    if (!values.length) return null;
    const sum = values.reduce((a, v) => a + v, 0);
    return fmtMovedPct(sum, false) + " " + label
      + " over " + values.length + " run(s)";
  };
  const parts = [bucket("window", "short-term"),
    bucket("weekly", "weekly")].filter(Boolean);
  let text = parts.length ? parts.join(" · ") : "–";
  if (racedOut) text += " · " + racedOut + " raced run(s) left out";
  return text;
};

// Short-term points between two plan-usage runs, or null. Mixed
// units never subtract. The caller dashes on null.
export const planDeltaText = (a, b) => {
  const da = a && a.allowance_delta;
  const db = b && b.allowance_delta;
  if (!da || !db || da.window == null || db.window == null) return null;
  const v = da.window - db.window;
  return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v) + " pts";
};

// Why a cost cell shows what it shows. A source label when a
// figure exists, a short reason when the cell is a dash.
export const costReason = (s, limit) => {
  if (!s) return "No cost recorded";
  if (visibleCost(s) != null) {
    if (s.cost_source === "list") {
      return "At Meta published list"
        + (s.pricing && s.pricing.fetched ? ". Fetched " + s.pricing.fetched : "");
    }
    if (s.cost_source === "computed") {
      return "Computed from recorded tokens at your rates. Input and output only";
    }
    return "Reported by the harness";
  }
  const unit = costUnit(s);
  if (unit === "none") return "Echo runs bill nothing";
  if (unit === "allowance") {
    if (s.allowance_start && s.allowance_end) {
      // A reset is on record only when a limit has readings on both
      // sides with different reset times. Otherwise it is missing.
      const keys = limit ? [limit] : ["window", "weekly"];
      const reset = keys.some((k) => {
        const a = s.allowance_start[k], b = s.allowance_end[k];
        return a && b && a.resets_at_ms !== b.resets_at_ms;
      });
      return reset ? "A usage limit reset during this run"
        : limit ? "No usage reading was recorded for this limit"
        : "No usage reading was recorded for this run";
    }
    if (s.status === "running" && s.allowance_start) {
      return "Usage for this run lands when it finishes";
    }
    return "No usage reading was recorded for this run";
  }
  if (s.cost_usd != null) {
    return "Claude Code priced this from Anthropic's list. That is not a Meta price, so it is hidden";
  }
  if (s.model === "muse-wonder-full-1.0") return "No public price for muse-wonder-full-1.0";
  if (s.status === "running") return "Cost lands when the run finishes";
  if (s.model === "muse-wonder-1.0") {
    if (s.input_tokens == null || s.output_tokens == null) {
      return "A token count was not recorded";
    }
    return "No list cost recorded for this run";
  }
  return "No cost recorded";
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
export const RUNS_SORTS = ["at", "prompt", "provider_model", "mode", "status", "harness_version", "calls", "wall_ms", "model_ms", "overhead_ms", "cost_usd"];
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

const FILTER_CHIP_SPECS = [
  { key: "provider", shared: true, fields: ["provider"], label: (f) => f.provider ? "Provider: " + f.provider : null },
  { key: "model", shared: true, fields: ["model"], label: (f) => f.model ? "Model: " + f.model : null },
  { key: "q", shared: true, fields: ["q"], label: (f) => f.q ? "Prompt: " + f.q : null },
  { key: "date", shared: true, fields: ["from", "to"], label: (f) => (f.from || f.to) ? "Date: " + (f.from || "…") + " → " + (f.to || "…") : null },
  { key: "status", shared: false, fields: ["status"], label: (f) => f.status ? "Status: " + f.status : null },
  { key: "mode", shared: false, fields: ["mode"], label: (f) => f.mode ? "Mode: " + f.mode : null },
  { key: "version", shared: false, fields: ["version"], label: (f) => f.version ? "Version: " + f.version : null },
];

export function parseSharedFilters(params) {
  const s = parseRunsQuery(params);
  const shared = {};
  FILTER_CHIP_SPECS.filter((spec) => spec.shared)
    .flatMap((spec) => spec.fields)
    .forEach((field) => { shared[field] = s[field]; });
  return shared;
}

export function sharedFilterCount(f) {
  if (!f) return 0;
  const sharedKeys = new Set(
    FILTER_CHIP_SPECS.filter((spec) => spec.shared).map((spec) => spec.key));
  return activeFilterChips(f).filter((chip) => sharedKeys.has(chip.key)).length;
}

export function hasSharedFilters(f) {
  return sharedFilterCount(f) > 0;
}

export function syncedFilterPanelOpen(previous, next, open, internalChange = false) {
  if (internalChange) return open;
  const was = hasSharedFilters(previous);
  const is = hasSharedFilters(next);
  return was === is ? open : is;
}

export function shouldCloseFilterPanelOnEscape(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.closest("select, input[type='date']")) return false;
  return Boolean(target.closest("#overviewSharedFilters, [data-filter-toggle]"));
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
  if (!f) return [];
  return FILTER_CHIP_SPECS.flatMap((spec) => {
    const label = spec.label(f);
    return label ? [{ key: spec.key, label }] : [];
  });
}

// --- Getting started walkthrough -----------------------------------
// Steps are plain data so ordering and route choices stay testable
// without a DOM. Copy follows the issue list and the README numbers
// language. Routes carry no query string. AppShell preserves it.
export function walkthroughSteps({ selectedId } = {}) {
  const overview = selectedId ? "/runs/" + encodeURIComponent(selectedId) : "/";
  const timeline = selectedId ? "/timeline/" + encodeURIComponent(selectedId) : "/timeline";
  return [
    { key: "terminal", route: null, target: '[data-tour="terminal"]',
      title: "Runs start in the terminal",
      body: "Run ./run-muse and type a prompt. Every run appears here with its timing recorded." },
    { key: "split", route: overview, target: '[data-tour="split"]',
      title: "Where the time went",
      body: "Wall is the whole run. It splits into Model, Tools, Approval wait, and Muse, all from timestamps in Muse's own log." },
    { key: "story", route: overview, target: '[data-tour="story"]',
      title: "The story of a run",
      body: "Once a run exists, this panel explains what happened and why it was slow, from recorded data only. A dash means the harness did not report it. Nothing is estimated." },
    { key: "per-call", route: overview, target: '[data-tour="per-call"]',
      title: "Every model call in order",
      body: "Model time and input tokens for each call in this run. One tall bar is usually where a slow run went." },
    { key: "runs", route: "/runs", target: '[data-view-panel="runs"] .runsTable thead',
      title: "Every run, one table",
      body: "Sort and filter all your runs here. Click any row to open that run in Overview." },
    { key: "compare", route: "/compare", target: '[data-view-panel="compare"] .panel',
      title: "Same prompt, side by side",
      body: "Compare sets line up medians over completed runs only. The fastest leg is marked fastest." },
    { key: "timeline", route: timeline,
      target: '[data-view-panel="timeline"] section.panel:nth-of-type(2) .panelHead',
      title: "Every recorded step",
      body: "Timeline lists each step Muse recorded for a run, in order. The middle column is time to the next step, not step cost." },
  ];
}

export function shouldCloseTourOnEscape(event) {
  if (!event || event.defaultPrevented) return false;
  const target = event.target;
  if (!target || typeof target.closest !== "function") return true;
  // Native select and date controls own Escape. The shared
  // filter panel owns it too. Its handler runs before this
  // document listener and marks the event, but check anyway.
  if (target.closest("select, input[type='date']")) return false;
  if (target.closest("#overviewSharedFilters, [data-filter-toggle]")) return false;
  return true;
}

export const WALKTHROUGH_SEEN_KEY = "muse-walkthrough-seen";

export function walkthroughSeen(storage) {
  try {
    return Boolean(storage && storage.getItem(WALKTHROUGH_SEEN_KEY));
  } catch (e) {
    return false;
  }
}

export function markWalkthroughSeen(storage) {
  try {
    if (storage) storage.setItem(WALKTHROUGH_SEEN_KEY, "1");
  } catch (e) { /* seen flag is a nicety, never a blocker */ }
}

// Clicking a column header cycles asc -> desc -> back to the default.
// Header click cycle: first direction, then the other, then back to
// the default. Time starts newest first, so its cycle is desc, asc.
// Without that, clicking Time on the default sort changed nothing.
export function nextRunsSort(current, sortId) {
  const first = sortId === "at" ? "desc" : "asc";
  const second = first === "asc" ? "desc" : "asc";
  if (current.sort !== sortId) return { sort: sortId, dir: first };
  if (current.dir === first) return { sort: sortId, dir: second };
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

// Round axis ticks from 0 up to at least max. Steps come from a
// 1, 2, 2.5, 5 ladder so labels stay short at any scale. A null
// max means no value was recorded, so the axis gets no ticks at
// all rather than an invented 0 to 1 scale. Integer mode (token
// axes) only ever yields whole-number steps and ticks.
export function linearTicks(max, intervals = 4, integer = false) {
  if (max == null) return { top: 1, ticks: [], step: 1 };
  if (!(max > 0)) return { top: 1, ticks: [0, 1], step: 1 };
  const raw = max / intervals;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = integer
    ? Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag)
    : (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const n = Math.ceil(max / step);
  const ticks = Array.from({ length: n + 1 }, (_, i) => Number((i * step).toFixed(10)));
  return { top: ticks[n], ticks, step: Number(step.toFixed(10)) };
}

// Seconds tick label with exactly the decimals the step needs, so
// a 0.25 step reads 0.25s, 0.50s and never rounds into a wrong
// value. Whole steps show no decimals.
export function fmtTickSec(v, step) {
  const s = Number((step || 0).toFixed(10));
  let decimals = 0;
  if (s > 0 && s < 1) decimals = -Math.floor(Math.log10(s));
  else if (s >= 1 && s < 10) decimals = 0;
  const mantissa = s > 0 ? s / 10 ** Math.floor(Math.log10(s)) : 0;
  if (Math.abs(mantissa - 2.5) < 1e-9) decimals += 1;
  if (s >= 10) decimals = 0;
  return Number(v).toFixed(decimals) + "s";
}

// Which bar indexes get an x label. First and last always show.
// If the last would sit closer than one label width to its
// neighbour, the neighbour gives way so labels never collide.
export function labelIndexes(count, plotWidth, minLabelWidth = 56) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const fit = Math.max(1, Math.floor(plotWidth / minLabelWidth));
  const stride = Math.max(1, Math.ceil(count / fit));
  const out = [];
  for (let i = 0; i < count; i += stride) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    const gapPx = (last - out[out.length - 1]) * (plotWidth / count);
    if (out.length > 1 && gapPx < minLabelWidth) out[out.length - 1] = last;
    else out.push(last);
  }
  return out;
}

// Brush window as inclusive run indexes, always inside the data
// and at least one run wide.
export function clampBrush(range, count) {
  if (!count || count < 1) return [0, 0];
  let [a, b] = range || [0, count - 1];
  a = Math.min(Math.max(0, Math.floor(a)), count - 1);
  b = Math.min(Math.max(a, Math.floor(b)), count - 1);
  return [a, b];
}

// Dragging one traveller. Each handle stops at the other, so a
// drag past it pins the window to that single run instead of
// collapsing or swapping sides.
export function brushResize(range, edge, index, count) {
  const [a, b] = clampBrush(range, count);
  if (edge === "left") return clampBrush([Math.min(index, b), b], count);
  return clampBrush([a, Math.max(index, a)], count);
}

// Dragging one traveller from wherever the pointer grabbed it.
// grabOffset is the distance from the edge (left edge at a, right
// edge at the exclusive end b + 1), so the edge follows the pointer
// instead of jumping to its band on the first move.
export function brushResizeAt(range, edge, grabOffset, indexFloat, count) {
  const target = Math.round(indexFloat - grabOffset);
  return brushResize(range, edge, edge === "right" ? target - 1 : target, count);
}

// Pixel positions of the two 10px brush grips. Normally each sits
// on its window edge. On a window narrower than both grips they
// sit side by side, so neither covers the other.
export function gripPositions(winX, winW, x, w) {
  const clamp = (gx) => Math.min(Math.max(gx, x), Math.max(x, x + w - 10));
  let leftX = clamp(winX);
  let rightX = clamp(winX + winW - 10);
  if (rightX < leftX + 10) {
    rightX = clamp(leftX + 10);
    if (rightX < leftX + 10) leftX = Math.max(x, rightX - 10);
  }
  return [leftX, rightX];
}

// Latest-request guard. Each issued request takes a token. Only
// the newest token is current, so a response that lands after a
// newer request was issued can be dropped.
export function latestOnly() {
  let latest = 0;
  return {
    take() { latest += 1; return latest; },
    isCurrent(token) { return token === latest; },
  };
}

// Dragging the window itself. grabOffset is how far into the
// window the pointer grabbed, in fractional runs. Span is kept.
export function brushPan(range, grabOffset, indexFloat, count) {
  const [a, b] = clampBrush(range, count);
  const span = b - a;
  const na = Math.min(Math.max(0, Math.round(indexFloat - grabOffset)), count - 1 - span);
  return clampBrush([na, na + span], count);
}

// Clicking the strip outside the window recentres the window on
// that point, clamped at both ends. Span is kept.
export function brushCentered(range, centerFloat, count) {
  const [a, b] = clampBrush(range, count);
  const span = b - a;
  const na = Math.min(Math.max(0, Math.round(centerFloat - (span + 1) / 2)), count - 1 - span);
  return clampBrush([na, na + span], count);
}

// Arrow keys on a focused traveller move it one run, Home and End
// send it to the ends. Returns null for keys the brush ignores.
export function brushKey(range, edge, key, count) {
  const [a, b] = clampBrush(range, count);
  const at = edge === "left" ? a : b;
  const to = key === "ArrowLeft" ? at - 1 : key === "ArrowRight" ? at + 1
    : key === "Home" ? 0 : key === "End" ? count - 1 : null;
  return to == null ? null : brushResize([a, b], edge, to, count);
}

// The brush window is stored with the run-id signature it was set
// on. It holds while the ids are unchanged or new runs only append
// at the end of the oldest-first order. Anything else means the
// run set changed, so the chart falls back to the full range.
export function brushWindow(win, sig) {
  if (!win || !win.range) return null;
  if (win.sig === sig || (win.sig !== "" && sig.startsWith(win.sig + "|"))) return win.range;
  return null;
}

// Chart tooltip box: right of the point, flipped left when it would
// spill past the chart, and clamped inside the chart box.
export function tipPosition(x, y, w, h, width, height) {
  let left = x + 14;
  if (left + w > width) left = x - 14 - w;
  return {
    left: Math.max(0, left),
    top: Math.min(Math.max(0, y - 12), Math.max(0, height - h)),
  };
}

// Keyboard step through chart bars. index -1 means none is active
// yet. Returns null for keys the chart ignores.
export function chartKeyIndex(key, index, count) {
  if (count <= 0) return null;
  if (key === "ArrowRight") return index < 0 ? 0 : Math.min(count - 1, index + 1);
  if (key === "ArrowLeft") return index < 0 ? count - 1 : Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

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
  if (sort === "cost_usd") {
    // Cost sorts in billed-unit groups, USD first in both
    // directions. USD runs by dollars, plan-usage runs by
    // short-term delta, the rest last. Never rank across units.
    const key = (s) => {
      const usd = visibleCost(s);
      if (usd != null) return [0, usd];
      const d = s.allowance_delta;
      if (d && d.window != null) return [1, d.window];
      return [2, 0];
    };
    const [ga, va] = key(a);
    const [gb, vb] = key(b);
    if (ga !== gb) return ga - gb;
    if (ga === 2) return 0;
    return dir === "desc" ? vb - va : va - vb;
  }
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
  // Strict: a share over partly recorded calls would be an estimate.
  const cacheComplete = chrono.length > 0
    && chrono.every((e) => e["gen_ai.usage.input_tokens"] != null
      && e["gen_ai.usage.cached_tokens"] != null);
  if (cacheComplete && hasCache && inSum > 0) {
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
  // A model note means the server found overlapping calls, so the
  // summed call time is not this run's. Never fall back to it.
  const modelTotal = hasEvents && !d.model_note
    ? (d.model_ms ?? (wires.length ? wires.reduce((a, b) => a + b, 0) : null))
    : null;
  // A run with no call events (Muse logged no model call) still has
  // a recorded wall time. A running run has none until it finishes.
  const wall = hasEvents ? (d.wall_ms ?? null) : (sel.wall_ms ?? null);
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
  // Strict: a slowest-call share needs every wire time recorded.
  const allWires = wires.length > 0 && wires.every((w) => w != null);

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
      && allWires && wireTotal > 0) {
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
  // Strict: same completeness rule as the explainLines cache share.
  const cacheComplete = chrono.length > 0
    && inputs.every((n) => n != null)
    && chrono.every((e) => e["gen_ai.usage.cached_tokens"] != null);
  if (cacheComplete && hasCache && chrono.length >= DIAG_CACHE_MIN_CALLS && inSum > 0) {
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
  if (fmtAllowance(sel.allowance_delta) !== "–") {
    lines.splice(lines.length - 1, 0,
      "- Plan usage: " + fmtAllowance(sel.allowance_delta, allowanceEqual(sel)));
  }
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
