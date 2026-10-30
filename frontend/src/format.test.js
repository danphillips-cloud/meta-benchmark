import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DID_NOT_COMPLETE, STATUSES, activeFilterChips, buildRunsQuery, chartData, compareSessions, explainLines, fastestOf, filterOptions, filterSessions, fmt, fmtSec, hasSharedFilters, inDateRange, isLongPrompt, promptPreview,
  diagnoseRun, liveStateText, median, overviewScope, parseReplayStart, parseRunsQuery, parseSharedFilters, perCallSeries, raceProgress, radarMatrix, radarReport, replayAt, replayLabel, replayPair, replaySeries, reproPack, runCard, runMode, selectedRunFacts, showBrush, toolTotals, usualBaseline, xrayFirstLanes, xrayHeadline, xrayLaneName, xrayLines, xraySeries,
} from "./format.js";

const S = (over) => ({
  run_id: "r1", at: "2026-01-01T00:00:00+00:00", prompt: "hello world",
  provider: "meta", model: "muse-wonder-1.0", compare_mode: null,
  status: "completed", calls: 2, wall_ms: 100, model_ms: 80,
  overhead_ms: 20, ...over,
});

test("isLongPrompt flags long text and many lines only", () => {
  assert.equal(isLongPrompt("what is 2+2"), false);
  assert.equal(isLongPrompt(""), false);
  assert.equal(isLongPrompt(null), false);
  assert.equal(isLongPrompt("x".repeat(300)), false);
  assert.equal(isLongPrompt("x".repeat(301)), true);
  assert.equal(isLongPrompt("one\ntwo\nthree"), false);
  assert.equal(isLongPrompt("one\ntwo\nthree\nfour"), true);
});

test("promptPreview cuts long prompts on a word boundary", () => {
  assert.equal(promptPreview("what is 2+2"), "what is 2+2");
  assert.equal(promptPreview(""), "");
  assert.equal(promptPreview(null), "");
  const long = ("build a game ").repeat(40).trim();
  const preview = promptPreview(long);
  assert.ok(preview.endsWith("…"));
  assert.ok(preview.length <= 281);
  assert.equal(long.startsWith(preview.slice(0, -1)), true);
  assert.equal(preview.slice(0, -1).endsWith(" "), false);
  assert.equal(promptPreview("one\ntwo\nthree\nfour"), "one\ntwo\nthree…");
  assert.equal(promptPreview("x".repeat(400)), "x".repeat(280) + "…");
});

test("honesty basics: missing renders as –, median skips nulls", () => {
  assert.equal(fmt(null), "–");
  assert.equal(median([null, 10, 20]), 15);
  assert.equal(median([null]), null);
});

test("raceProgress shows running legs only, elapsed from recorded start", () => {
  const now = Date.parse("2026-01-01T00:01:00+00:00");
  const rows = raceProgress([
    S({ run_id: "done", status: "completed" }),
    S({ run_id: "run2", status: "running", model: "m2", calls: 3, model_ms: 900, at: "2026-01-01T00:00:30+00:00" }),
    S({ run_id: "run1", status: "running", model: "m1", calls: 1, model_ms: 100, at: "2026-01-01T00:00:00+00:00" }),
    S({ run_id: "run3", status: "running", model: "m3", at: null }),
  ], now);
  assert.deepEqual(rows.map((r) => r.run_id), ["run1", "run2", "run3"]);
  assert.equal(rows[0].leg, "meta/m1");
  assert.equal(rows[0].elapsed_ms, 60000);
  assert.equal(rows[0].calls, 1);
  assert.equal(rows[1].elapsed_ms, 30000);
  assert.equal(rows[1].model_ms, 900);
  assert.equal(rows[2].elapsed_ms, null);
  assert.deepEqual(raceProgress([S({})], now), []);
  assert.deepEqual(raceProgress(null, now), []);
});

test("runMode defaults single runs to 'single'", () => {
  assert.equal(runMode(S({})), "single");
  assert.equal(runMode(S({ compare_mode: "meta" })), "meta");
  assert.equal(runMode(null), "single");
});

test("parseRunsQuery defaults and validation", () => {
  assert.deepEqual(parseRunsQuery(new URLSearchParams("")),
    { q: "", provider: "", model: "", status: "", mode: "", version: "", sort: "at", dir: "desc", from: "", to: "" });
  assert.deepEqual(parseRunsQuery(new URLSearchParams("q=hi&provider=meta&sort=wall_ms&dir=asc")),
    { q: "hi", provider: "meta", model: "", status: "", mode: "", version: "", sort: "wall_ms", dir: "asc", from: "", to: "" });
  // Unknown sort/dir fall back to the safe default, never crash.
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).sort, "at");
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).dir, "desc");
  assert.equal(parseRunsQuery("status=failed").status, "failed");
});

test("buildRunsQuery round-trips through parseRunsQuery", () => {
  const state = { q: "hi there", provider: "meta", model: "m1", status: "failed", mode: "claude", version: "1.0", sort: "wall_ms", dir: "asc", from: "2026-01-01", to: "2026-01-31" };
  assert.deepEqual(parseRunsQuery(buildRunsQuery(state)), state);
  // Defaults stay out of the URL so the plain /runs link is clean.
  assert.equal(buildRunsQuery({ q: "", provider: "", model: "", status: "", mode: "", version: "", sort: "at", dir: "desc" }).toString(), "");
  // A non-date string in the URL is dropped, never trusted.
  assert.equal(parseRunsQuery(new URLSearchParams("to=nope")).to, "");
});

test("filterSessions applies every filter, failed rows stay visible", () => {
  const rows = [
    S({ run_id: "a", prompt: "Hello world", status: "completed" }),
    S({ run_id: "b", prompt: "other", provider: "claude-code", model: "claude-x", status: "failed", compare_mode: "claude" }),
    S({ run_id: "c", prompt: "hello again", status: "interrupted", compare_mode: "meta" }),
  ];
  const none = { q: "", provider: "", model: "", status: "", mode: "" };
  assert.equal(filterSessions(rows, none).length, 3);
  assert.deepEqual(filterSessions(rows, { ...none, q: "HELLO" }).map((s) => s.run_id), ["a", "c"]);
  assert.deepEqual(filterSessions(rows, { ...none, provider: "claude-code" }).map((s) => s.run_id), ["b"]);
  assert.deepEqual(filterSessions(rows, { ...none, model: "claude-x" }).map((s) => s.run_id), ["b"]);
  assert.deepEqual(filterSessions(rows, { ...none, status: "failed" }).map((s) => s.run_id), ["b"]);
  assert.deepEqual(filterSessions(rows, { ...none, mode: "meta" }).map((s) => s.run_id), ["c"]);
  assert.deepEqual(filterSessions(rows, { ...none, mode: "single" }).map((s) => s.run_id), ["a"]);
});

test("compareSessions sorts and keeps missing values last both ways", () => {
  const a = S({ run_id: "a", wall_ms: 100, at: "2026-01-01T00:00:00+00:00" });
  const b = S({ run_id: "b", wall_ms: 300, at: "2026-01-03T00:00:00+00:00" });
  const c = S({ run_id: "c", wall_ms: null, at: "2026-01-02T00:00:00+00:00" });
  const asc = [b, c, a].sort((x, y) => compareSessions(x, y, "wall_ms", "asc")).map((s) => s.run_id);
  const desc = [a, c, b].sort((x, y) => compareSessions(x, y, "wall_ms", "desc")).map((s) => s.run_id);
  assert.deepEqual(asc, ["a", "b", "c"]);
  assert.deepEqual(desc, ["b", "a", "c"]);
  const byTime = [a, c, b].sort((x, y) => compareSessions(x, y, "at", "desc")).map((s) => s.run_id);
  assert.deepEqual(byTime, ["b", "c", "a"]);
});

test("shared filters: date range is inclusive and chips list active filters", () => {
  assert.equal(inDateRange("2026-01-15T12:00:00", "2026-01-01", "2026-01-31"), true);
  assert.equal(inDateRange("2026-01-31T23:30:00", "", "2026-01-31"), true);
  assert.equal(inDateRange("2026-02-01T00:30:00", "", "2026-01-31"), false);
  assert.equal(inDateRange("2025-12-31T23:30:00", "2026-01-01", ""), false);
  assert.equal(inDateRange(null, "2026-01-01", ""), false);
  assert.equal(inDateRange(null, "", ""), true);
  const rows = [
    S({ run_id: "a", at: "2026-01-10T10:00:00" }),
    S({ run_id: "b", at: "2026-03-10T10:00:00" }),
  ];
  const none = { q: "", provider: "", model: "", status: "", mode: "" };
  assert.deepEqual(filterSessions(rows, { ...none, from: "2026-01-01", to: "2026-01-31" }).map((s) => s.run_id), ["a"]);
  assert.deepEqual(parseSharedFilters(new URLSearchParams("provider=meta&q=hi&from=2026-01-01")),
    { q: "hi", provider: "meta", model: "", from: "2026-01-01", to: "" });
  assert.equal(hasSharedFilters({ q: "", provider: "", model: "", from: "", to: "" }), false);
  assert.equal(hasSharedFilters({ q: "", provider: "meta", model: "", from: "", to: "" }), true);
  assert.deepEqual(activeFilterChips({ provider: "meta", model: "", q: "hi", from: "2026-01-01", to: "", status: "", mode: "" }).map((c) => c.key),
    ["provider", "q", "date"]);
  assert.deepEqual(activeFilterChips({ provider: "", model: "", q: "", from: "", to: "" }), []);
});

test("overviewScope: no filter keeps compare-set scoping, a filter overrides it", () => {
  const data = {
    selected: "a",
    sessions: [
      S({ run_id: "a", comparison_id: "set1", provider: "meta" }),
      S({ run_id: "b", comparison_id: "set1", provider: "claude-code", model: "claude-x" }),
      S({ run_id: "c", comparison_id: null, provider: "claude-code", model: "claude-x" }),
    ],
  };
  const plain = overviewScope(data, { q: "", provider: "", model: "", from: "", to: "" });
  assert.deepEqual(plain.runs.map((s) => s.run_id), ["a", "b"]);
  const filtered = overviewScope(data, { q: "", provider: "claude-code", model: "", from: "", to: "" });
  assert.deepEqual(filtered.runs.map((s) => s.run_id), ["b", "c"]);
  assert.match(filtered.label, /^Filtered/);
});

test("chartData: stacked seconds, no model time is overhead only, never estimated", () => {
  const runs = [
    S({ run_id: "new", wall_ms: 10000, model_ms: 8000, overhead_ms: 2000 }),
    S({ run_id: "mid", wall_ms: 5000, model_ms: null, overhead_ms: 5000 }),
    S({ run_id: "old", wall_ms: null, model_ms: null, overhead_ms: null, status: "failed" }),
  ];
  const d = chartData(runs, "mid");
  // Chronological (oldest first), the reverse of the newest-first input.
  assert.deepEqual(d.map((x) => x.run_id), ["old", "mid", "new"]);
  assert.equal(d[2].model_s, 8); assert.equal(d[2].overhead_s, 2);
  assert.equal(d[2].model_s + d[2].overhead_s, 10);
  // No reported model time: model segment is 0, everything is overhead.
  assert.equal(d[1].model_s, 0); assert.equal(d[1].overhead_s, 5);
  assert.equal(d[1].isSelected, true);
  // No wall time: nothing drawn, tooltip values stay null (not 0 s).
  assert.equal(d[0].wall_ms, null); assert.equal(d[0].model_s, 0); assert.equal(d[0].greyed, true);
  assert.equal(fmtSec(2500), "2.500 s"); assert.equal(fmtSec(null), "–");
  assert.equal(showBrush(12), false); assert.equal(showBrush(13), true);
});

// --- Diagnose a slow run -------------------------------------------
// Events use the server shape (newest first). E() builds one event.
const E = (wire, input, cached, output) => ({
  "wire_ms": wire,
  "gen_ai.usage.input_tokens": input,
  "gen_ai.usage.cached_tokens": cached,
  "gen_ai.usage.output_tokens": output,
});

test("explainLines: all four lines from recorded data, model dominated", () => {
  // Newest first: call3, call2, call1.
  const events = [E(2000, 3000, 2500, 10), E(5000, 2000, 1000, 10), E(3000, 1000, 0, 10)];
  const lines = explainLines({ wall_ms: 12000, model_ms: 10000, provider: "meta", events });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /Model time was 10\.0 s of 12\.0 s wall \(83%\)\. Model dominated\./);
  assert.match(lines[1], /Input tokens: 1,000 on call 1 → 3,000 on call 3 \(\+2,000\)\./);
  assert.match(lines[2], /Slowest call was #2 at 5\.0 s with 2,000 input tokens\./);
  assert.match(lines[3], /Cache covered 3,500 of 6,000 input tokens \(58%\)\./);
});

test("explainLines: overhead dominated wording", () => {
  const lines = explainLines({ wall_ms: 10000, model_ms: 2000, provider: "meta", events: [E(2000, 100, 0, 1)] });
  assert.match(lines[0], /Overhead dominated\./);
});

test("explainLines: each line appears only when its data exists", () => {
  // No wall/model: no share line.
  assert.deepEqual(explainLines({ wall_ms: null, model_ms: null, provider: "meta", events: [] }), []);
  // Single call: no growth line, but slowest + share still show.
  const single = explainLines({ wall_ms: 3000, model_ms: 3000, provider: "meta", events: [E(3000, 500, null, 5)] });
  assert.equal(single.length, 2);
  assert.ok(!single.some((l) => l.startsWith("Input tokens")));
  assert.ok(!single.some((l) => l.startsWith("Cache covered")));
  // Missing input on an end call: no growth line.
  const noInput = explainLines({ wall_ms: 8000, model_ms: 8000, provider: "meta", events: [E(4000, null, null, 1), E(4000, 100, null, 1)] });
  assert.ok(!noInput.some((l) => l.startsWith("Input tokens")));
  // No cache data at all: no cache line.
  const noCache = explainLines({ wall_ms: 8000, model_ms: 8000, provider: "meta", events: [E(4000, 200, null, 1), E(4000, 100, null, 1)] });
  assert.ok(!noCache.some((l) => l.startsWith("Cache")));
  // No per-call time: no slowest line.
  const noWire = explainLines({ wall_ms: 8000, model_ms: 5000, provider: "meta", events: [E(null, 200, 100, 1), E(null, 100, 50, 1)] });
  assert.ok(!noWire.some((l) => l.startsWith("Slowest")));
});

test("explainLines: Claude Code runs skip the slowest-call line", () => {
  const events = [E(null, 3000, 2500, null), E(null, 1000, 0, null)];
  const lines = explainLines({ wall_ms: 5000, model_ms: 4000, provider: "claude-code", events });
  assert.ok(!lines.some((l) => l.startsWith("Slowest")));
  // Share, growth and cache lines still come from recorded totals.
  assert.ok(lines.some((l) => l.startsWith("Model time was")));
  assert.ok(lines.some((l) => l.startsWith("Input tokens")));
  assert.ok(lines.some((l) => l.startsWith("Cache covered")));
  // Even if a wire value were present, Claude Code never shows slowest.
  const withWire = explainLines({ wall_ms: 5000, model_ms: 4000, provider: "claude-code", events: [E(9000, 100, 0, 1)] });
  assert.ok(!withWire.some((l) => l.startsWith("Slowest")));
});

test("usualBaseline: same prompt, provider and model, at least 3 earlier completed", () => {
  const sel = S({ run_id: "sel", at: "2026-01-10T00:00:00+00:00", prompt: "hi", provider: "meta", model: "m1", wall_ms: 18500 });
  const earlier = (id, at, wall) => S({ run_id: id, at, prompt: "hi", provider: "meta", model: "m1", wall_ms: wall, model_ms: wall - 100, overhead_ms: 100 });
  const sessions = [
    sel,
    earlier("e3", "2026-01-03T00:00:00+00:00", 14000),
    earlier("e2", "2026-01-02T00:00:00+00:00", 12000),
    earlier("e1", "2026-01-01T00:00:00+00:00", 10000),
  ];
  const base = usualBaseline(sel, sessions);
  assert.equal(base.count, 3);
  assert.equal(base.wall_ms, 12000);
  // Only 2 earlier runs: hidden.
  assert.equal(usualBaseline(sel, sessions.slice(0, 3)), null);
  // Different prompt never counts, even with 3 runs.
  const otherPrompt = sessions.map((s) => s.run_id === "sel" ? s : { ...s, prompt: "other" });
  assert.equal(usualBaseline(sel, otherPrompt), null);
  // Different provider or model never counts.
  const otherProvider = sessions.map((s) => s.run_id === "sel" ? s : { ...s, provider: "claude-code" });
  assert.equal(usualBaseline(sel, otherProvider), null);
  const otherModel = sessions.map((s) => s.run_id === "sel" ? s : { ...s, model: "other" });
  assert.equal(usualBaseline(sel, otherModel), null);
  // Failed/interrupted and later runs never count.
  const mixed = [
    sel,
    earlier("ok1", "2026-01-01T00:00:00+00:00", 10000),
    earlier("ok2", "2026-01-02T00:00:00+00:00", 10000),
    { ...earlier("bad", "2026-01-03T00:00:00+00:00", 10000), status: "failed" },
    earlier("later", "2026-01-20T00:00:00+00:00", 10000),
  ];
  assert.equal(usualBaseline(sel, mixed), null);
  // The selected run itself never counts.
  assert.equal(usualBaseline(sel, [sel, sel, sel, sel]), null);
  assert.equal(usualBaseline(null, sessions), null);
});

test("perCallSeries: oldest-first model time and input tokens, Muse only", () => {
  const events = [E(2000, 3000, 2500, 10), E(5000, 2000, 1000, 10), E(3000, 1000, 0, 10)];
  assert.deepEqual(perCallSeries(events, "meta"), [
    { call: 1, model_ms: 3000, input_tokens: 1000, cached_tokens: 0, output_tokens: 10, retries: 0, stalled_ms: null },
    { call: 2, model_ms: 5000, input_tokens: 2000, cached_tokens: 1000, output_tokens: 10, retries: 0, stalled_ms: null },
    { call: 3, model_ms: 2000, input_tokens: 3000, cached_tokens: 2500, output_tokens: 10, retries: 0, stalled_ms: null },
  ]);
  assert.deepEqual(perCallSeries(events, "claude-code"), []);
  assert.deepEqual(perCallSeries([], "meta"), []);
  // Missing values stay null, never 0.
  assert.deepEqual(perCallSeries([E(null, null, null, null)], "meta"),
    [{ call: 1, model_ms: null, input_tokens: null, cached_tokens: null, output_tokens: null, retries: 0, stalled_ms: null }]);
});

test("version filter: filterSessions and chips honour harness_version", () => {
  const rows = [
    S({ run_id: "a", harness_version: "Muse Code 1.4.13" }),
    S({ run_id: "b", harness_version: "2.1.310 (Claude Code)" }),
    S({ run_id: "c", harness_version: null }),
  ];
  const none = { q: "", provider: "", model: "", status: "", mode: "", version: "" };
  assert.equal(filterSessions(rows, none).length, 3);
  assert.deepEqual(filterSessions(rows, { ...none, version: "Muse Code 1.4.13" }).map((s) => s.run_id), ["a"]);
  assert.deepEqual(activeFilterChips({ provider: "", model: "", q: "", from: "", to: "", status: "", mode: "", version: "1.0" }).map((c) => c.key), ["version"]);
  const sorted = [rows[1], rows[2], rows[0]].sort((x, y) => compareSessions(x, y, "harness_version", "asc")).map((s) => s.run_id);
  assert.deepEqual(sorted, ["b", "a", "c"]);
});

test("explainLines: a near-even split is not called domination", () => {
  const lines = explainLines({ wall_ms: 18500, model_ms: 9400, provider: "meta", events: [] });
  assert.match(lines[0], /\(51%\)\. Model and overhead were about even\./);
});

test("explainLines: tool and approval lines only when the split has them", () => {
  const events = [E(3000, 1000, 0, 10)];
  const withSplit = explainLines({ wall_ms: 50000, model_ms: 10000, provider: "meta", events, split: { tool_ms: 41000, approval_ms: 126000, muse_ms: null } });
  assert.ok(withSplit.some((l) => l === "Tools ran for 41.0 s."));
  assert.ok(withSplit.some((l) => l.startsWith("Waited ")));
  const zero = explainLines({ wall_ms: 5000, model_ms: 5000, provider: "meta", events, split: { tool_ms: 0, approval_ms: 0, muse_ms: 0 } });
  assert.ok(!zero.some((l) => l.startsWith("Tools ran") || l.startsWith("Waited")));
  const missing = explainLines({ wall_ms: 5000, model_ms: 5000, provider: "meta", events, split: { tool_ms: null, approval_ms: null, muse_ms: null } });
  assert.ok(!missing.some((l) => l.startsWith("Tools ran") || l.startsWith("Waited")));
  const noSplit = explainLines({ wall_ms: 5000, model_ms: 5000, provider: "meta", events });
  assert.ok(!noSplit.some((l) => l.startsWith("Tools ran") || l.startsWith("Waited")));
});

test("explainLines + perCallSeries: retry shown only on the retried call", () => {
  // Newest first: call2 (clean), call1 (one retry, 5 s stalled).
  const events = [
    { ...E(3000, 110, 0, 11), retries: 0, stalled_ms: null },
    { ...E(11000, 100, 0, 10), retries: 1, stalled_ms: 5000 },
  ];
  const lines = explainLines({ wall_ms: 14000, model_ms: 14000, provider: "meta", events });
  assert.ok(lines.some((l) => l === "Call 1 retried once after the connection stalled for 5.0 s."));
  assert.ok(!lines.some((l) => l.startsWith("Call 2 retried")));
  const clean = explainLines({ wall_ms: 3000, model_ms: 3000, provider: "meta", events: [E(3000, 100, 0, 10)] });
  assert.ok(!clean.some((l) => l.includes("retried")));
  assert.deepEqual(perCallSeries(events, "meta").map((d) => [d.retries, d.stalled_ms]),
    [[1, 5000], [0, null]]);
  assert.equal(liveStateText({ state: "retrying connection", tool: null, attempt: "2/10" }),
    "Retrying connection (attempt 2/10)");
});

test("liveStateText: banner wording for every live state", () => {
  assert.equal(liveStateText(null), "");
  assert.equal(liveStateText({ state: "waiting for approval", tool: "Bash" }), "Waiting for approval: Bash");
  assert.equal(liveStateText({ state: "tool running", tool: "Read" }), "Tool running: Read");
  assert.equal(liveStateText({ state: "model call running", tool: null }), "Model call running");
  assert.equal(liveStateText({ state: "idle", tool: null }), "Idle");
  assert.equal(liveStateText({ state: "ended", tool: null }), "Ended");
});

test("no invented zeros: null model time stays null and medians skip it", () => {
  assert.equal(median([null, null]), null);
  assert.equal(median([null, 0, 10]), 5);
  assert.equal(median([0]), 0);
  const d = chartData([S({ run_id: "x", wall_ms: 900, model_ms: null, overhead_ms: null })], null);
  assert.equal(d[0].model_ms, null);
  assert.equal(fmtSec(d[0].model_ms), "–");
  const zero = chartData([S({ run_id: "y", wall_ms: 900, model_ms: 0, overhead_ms: 900 })], null);
  assert.equal(zero[0].model_ms, 0);
});

test("fastestOf: tied fastest keys and ratio, nothing when it cannot say", () => {
  const rows = [
    { key: "a", wall: 100 }, { key: "b", wall: 300 }, { key: "c", wall: null },
  ];
  const one = fastestOf(rows);
  assert.deepEqual([...one.fastestKeys], ["a"]);
  assert.equal(one.fastRatio, 3);
  const tied = fastestOf([{ key: "a", wall: 100 }, { key: "b", wall: 100 }, { key: "c", wall: 200 }]);
  assert.deepEqual([...tied.fastestKeys].sort(), ["a", "b"]);
  assert.equal(tied.fastRatio, 2);
  // Fewer than two groups with a wall time, or all equal: no badge.
  assert.deepEqual(fastestOf([{ key: "a", wall: 100 }]), { fastestKeys: new Set(), fastRatio: null });
  assert.deepEqual(fastestOf([{ key: "a", wall: 100 }, { key: "b", wall: 100 }]), { fastestKeys: new Set(), fastRatio: null });
  assert.deepEqual(fastestOf([]), { fastestKeys: new Set(), fastRatio: null });
  assert.deepEqual(fastestOf([{ key: "a", wall: 0 }, { key: "b", wall: 100 }]), { fastestKeys: new Set(), fastRatio: null });
});

test("status constants: DID_NOT_COMPLETE is every known status that did not finish", () => {
  assert.deepEqual(DID_NOT_COMPLETE, ["failed", "interrupted", "timeout", "needs_approval"]);
  assert.ok(STATUSES.includes("completed") && STATUSES.includes("running"));
  assert.ok(!DID_NOT_COMPLETE.includes("completed") && !DID_NOT_COMPLETE.includes("running"));
});

test("filterOptions: sorted unique providers and models, blanks dropped", () => {
  const rows = [
    S({ provider: "meta", model: "m2" }),
    S({ provider: "claude-code", model: "m1" }),
    S({ provider: "meta", model: "m2" }),
    S({ provider: null, model: null }),
  ];
  assert.deepEqual(filterOptions(rows), { providers: ["claude-code", "meta"], models: ["m1", "m2"] });
  assert.deepEqual(filterOptions([]), { providers: [], models: [] });
});

test("usualBaseline: never compares across context modes", () => {
  const base = { prompt: "p", provider: "meta", model: "m", status: "completed", wall_ms: 1000 };
  const earlier = [1, 2, 3].map((i) => ({ ...base, run_id: "e" + i, at: "2026-01-0" + i, context_mode: "full" }));
  const sel = { ...base, run_id: "sel", at: "2026-01-09", context_mode: "minimal" };
  assert.equal(usualBaseline(sel, earlier), null);
  assert.equal(usualBaseline({ ...sel, context_mode: "full" }, earlier).count, 3);
});

const T = (at, operation, wire_ms = null, duration_ms = null) => ({ at, operation, wire_ms, duration_ms });

const REPLAY_TIMELINE = [
  T("2026-01-01T00:00:00.000Z", "runtime.user_intent.accepted accepted"),
  T("2026-01-01T00:00:05.000Z", "runtime.session model_completed", 4000, 100),
  T(null, "system init"),
  T("2026-01-01T00:00:08.000Z", "tool_batch.effect.started tool_batch_effect"),
  T("2026-01-01T00:00:10.000Z", "runtime.session model_completed", 1500, 0),
];

// Newest first, as the server sends events. Call 1 retried and stalled.
const REPLAY_EVENTS = [
  { ...E(1500, 200, 50, 20), retries: 0, stalled_ms: null },
  { ...E(4000, 100, 0, 10), retries: 1, stalled_ms: 3000 },
];

test("replayLabel: friendly names for known steps, raw text otherwise", () => {
  assert.equal(replayLabel("runtime.session model_completed"), "Model call landed");
  assert.equal(replayLabel("runtime.user_intent.accepted accepted"), "Prompt accepted");
  assert.equal(replayLabel("tool_batch.effect.started tool_batch_effect"), "Tool started");
  assert.equal(replayLabel("tool_batch.effect.terminal tool_batch_effect"), "Tool finished");
  assert.equal(replayLabel("approval_wait.effect.started x"), "Approval wait started");
  assert.equal(replayLabel("approval_wait.effect.terminal x"), "Approval wait ended");
  assert.equal(replayLabel("weird new thing"), "weird new thing");
  assert.equal(replayLabel(null), "–");
});

test("replaySeries: timed points get real offsets, untimed rows stay off the ruler", () => {
  const s = replaySeries(REPLAY_TIMELINE, REPLAY_EVENTS);
  assert.equal(s.span_ms, 10000);
  assert.deepEqual(s.points.map((p) => p.offset_ms), [0, 5000, 8000, 10000]);
  assert.deepEqual(s.points.map((p) => p.kind), ["step", "model", "tool", "model"]);
  assert.equal(s.untimed.length, 1);
  assert.equal(s.untimed[0].operation, "system init");
  // A model bar start is its landing time minus its recorded model time.
  assert.equal(s.points[1].model_start_ms, 1000);
  assert.equal(s.points[3].model_start_ms, 8500);
  assert.equal(s.points[0].model_start_ms, null);
  // Landings pair model rows with calls in order, retry fields included.
  assert.deepEqual(s.landings.map((l) => [l.call, l.offset_ms, l.input_tokens, l.retries, l.stalled_ms]),
    [[1, 5000, 100, 1, 3000], [2, 10000, 200, 0, null]]);
  assert.deepEqual(replaySeries([], []), { points: [], untimed: [], landings: [], span_ms: 0, start_at: null, end_at: null });
  assert.deepEqual(replaySeries(null, null).points, []);
});

test("replayAt: counters only count calls that had landed by then", () => {
  const s = replaySeries(REPLAY_TIMELINE, REPLAY_EVENTS);
  const before = replayAt(s, 2000);
  assert.equal(before.calls_landed, 0);
  assert.equal(before.input_tokens, null);
  assert.equal(before.model_ms, null);
  assert.equal(before.in_flight_call, 1);
  assert.equal(before.current.label, "Prompt accepted");
  assert.equal(before.next.offset_ms, 5000);
  const mid = replayAt(s, 5000);
  assert.equal(mid.calls_landed, 1);
  assert.equal(mid.input_tokens, 100);
  assert.equal(mid.output_tokens, 10);
  assert.equal(mid.model_ms, 4000);
  assert.equal(mid.in_flight_call, null);
  const end = replayAt(s, 999999);
  assert.equal(end.offset_ms, 10000);
  assert.equal(end.calls_landed, 2);
  assert.equal(end.input_tokens, 300);
  assert.equal(end.model_ms, 5500);
  assert.equal(end.next, null);
  // A landed call with a missing value makes that total a dash, not a part sum.
  const missing = replaySeries(REPLAY_TIMELINE, [
    { ...E(1500, 200, 50, 20), retries: 0, stalled_ms: null },
    { ...E(null, null, null, null), retries: 0, stalled_ms: null },
  ]);
  assert.equal(replayAt(missing, 10000).input_tokens, null);
  assert.equal(replayAt(missing, 10000).calls_landed, 2);
});

test("replayPair: shared span, merged offsets, recorded start gap", () => {
  const a = replaySeries(REPLAY_TIMELINE, REPLAY_EVENTS);
  const b = replaySeries([
    T("2026-01-01T00:00:02.000Z", "runtime.user_intent.accepted accepted"),
    T("2026-01-01T00:00:07.000Z", "runtime.session model_completed", 3000, 0),
    T("2026-01-01T00:00:07.000Z", "runtime.session capture"),
    T("2026-01-01T00:00:20.000Z", "runtime.session model_completed", 2000, 0),
  ], []);
  const pair = replayPair(a, b);
  assert.equal(pair.span_ms, 18000);
  assert.deepEqual(pair.offsets, [0, 5000, 8000, 10000, 18000]);
  assert.equal(pair.gap_ms, 2000);
  assert.equal(replayPair(b, a).gap_ms, -2000);
  // Missing starts give a null gap, never a made-up zero.
  assert.equal(replayPair(a, replaySeries([], [])).gap_ms, null);
  assert.equal(replayPair(a, replaySeries([], [])).span_ms, 10000);
  assert.deepEqual(replayPair(null, null), { span_ms: 0, offsets: [], gap_ms: null });
  assert.deepEqual(replayPair(undefined, a).offsets, [0, 5000, 8000, 10000]);
});

test("replaySeries: no timed model rows means no landings, steps still replay", () => {
  const tl = [
    T(null, "system init", null, 2745),
    T("2026-01-01T00:00:03.000Z", "assistant", null, 421),
    T("2026-01-01T00:00:04.000Z", "user", null, 1212),
  ];
  const s = replaySeries(tl, [E(null, 1632, 0, null)]);
  assert.deepEqual(s.points.map((p) => p.offset_ms), [0, 1000]);
  assert.deepEqual(s.landings, []);
  assert.equal(replayAt(s, 1000).input_tokens, null);
});

const LANE = (lane, bytes, wire = "w", lane_count = 1) => ({ lane, source: "s", wire, bytes, lane_count });
const TRACE = (step, total, user, lanes, og = 0, ob = 0) => ({
  step, total_bytes: total, user_bytes: user, omitted_groups: og, omitted_bytes: ob, lanes,
});
const XRAY = [
  TRACE(0, 1000, 10, [LANE("system_base", 600), LANE("context", 390), LANE("history", 10), LANE("provider_options", 0, "option:a"), LANE("provider_options", 0, "option:b")]),
  TRACE(1, 1250, 10, [LANE("system_base", 600), LANE("context", 390), LANE("history", 200, "w", 3), LANE("tool_result", 10)], 1, 50),
];

test("xrayLaneName: friendly names, raw fallback, dash for missing", () => {
  assert.equal(xrayLaneName("system_base"), "System prompt");
  assert.equal(xrayLaneName("history"), "Conversation so far");
  assert.equal(xrayLaneName("future_lane"), "future_lane");
  assert.equal(xrayLaneName(null), "–");
});

test("xraySeries: lanes group by name, zero groups counted, widths in bytes", () => {
  const s = xraySeries(XRAY);
  assert.deepEqual(s.steps.map((t) => t.total_bytes), [1000, 1250]);
  assert.deepEqual(s.laneOrder, ["system_base", "context", "history", "tool_result"]);
  // Duplicate provider_options groups merge into one zero lane, kept out
  // of the bars but counted as raw zero groups.
  assert.equal(s.steps[0].zero_groups, 2);
  assert.ok(!s.steps[0].lanes.some((l) => l.lane === "provider_options"));
  assert.deepEqual(s.steps[0].lanes.map((l) => [l.lane, l.bytes]),
    [["system_base", 600], ["context", 390], ["history", 10]]);
  assert.equal(s.steps[1].partial, true);
  assert.equal(s.steps[0].partial, false);
  // A lane with bytes in one step and none recorded in another is null
  // there, so the table can show a dash instead of an invented 0.
  assert.equal(s.steps[0].byLane.tool_result, null);
  assert.equal(s.steps[1].byLane.tool_result, 10);
  assert.deepEqual(xraySeries([]), { steps: [], laneOrder: [] });
  assert.deepEqual(xraySeries(null).steps, []);
});

test("xrayHeadline and xrayLines: first-call story from recorded bytes only", () => {
  const s = xraySeries(XRAY);
  const head = xrayHeadline(s);
  assert.equal(head.total_bytes, 1000);
  assert.equal(head.user_bytes, 10);
  assert.equal(head.user_pct, 1);
  const lines = xrayLines(s);
  assert.ok(lines.some((l) => l === "Request size grew from 1,000 to 1,250 bytes across 2 calls (+250 bytes)."));
  assert.ok(lines.some((l) => l === "Conversation so far grew from 10 to 200 bytes."));
  assert.ok(lines.some((l) => l === "System prompt held at 600 bytes on every call."));
  assert.ok(lines.some((l) => l.includes("partial")));
  // Nothing recorded, nothing said.
  assert.equal(xrayHeadline(xraySeries([])), null);
  assert.deepEqual(xrayLines(xraySeries([])), []);
  const missing = xrayHeadline(xraySeries([TRACE(0, null, null, [])]));
  assert.deepEqual(missing, { total_bytes: null, user_bytes: null, user_pct: null });
});

const VA = "Muse Code 1.4.13 (fake-a)";
const VB = "Muse Code 1.4.14 (fake-b)";
const RS = (over) => ({
  suite_prompt: "sky", prompt: "why blue", provider: "meta", model: "m1",
  context_mode: "minimal", harness_version: VA, status: "completed",
  at: "2026-01-01T00:00:00Z", wall_ms: 200, model_ms: 80,
  input_tokens: 1000, ...over,
});
const RADAR_ROWS = [
  RS({ run_id: "1", wall_ms: 100 }),
  RS({ run_id: "2", wall_ms: 300, at: "2026-01-02T00:00:00Z" }),
  RS({ run_id: "3", wall_ms: 200, at: "2026-01-03T00:00:00Z" }),
  RS({ run_id: "4", wall_ms: 400, harness_version: VB, at: "2026-02-01T00:00:00Z" }),
  RS({ run_id: "5", wall_ms: 600, harness_version: VB, at: "2026-02-02T00:00:00Z" }),
  RS({ run_id: "6", wall_ms: 99999, status: "failed", harness_version: VB, at: "2026-02-03T00:00:00Z" }),
  RS({ run_id: "7", suite_prompt: null, prompt: "loose prompt", harness_version: null }),
];

test("radarMatrix: version columns, medians, threshold delta", () => {
  const m = radarMatrix(RADAR_ROWS);
  assert.deepEqual(m.versions.map((v) => v.label), ["Version not recorded", VA, VB]);
  const sky = m.rows[0];
  assert.equal(sky.label, "sky");
  assert.equal(sky.suite, true);
  assert.equal(sky.cells[VA].n, 3);
  assert.equal(sky.cells[VA].wall_ms, 200);
  // The failed run never feeds a median or a count.
  assert.equal(sky.cells[VB].n, 2);
  assert.equal(sky.cells[VB].wall_ms, 500);
  assert.equal(sky.delta.from_version, VA);
  assert.equal(sky.delta.to_version, VB);
  assert.deepEqual(sky.delta.wall_ms, { from: 200, to: 500, diff: 300, pct: 150 });
  const loose = m.rows.find((r) => r.label === "loose prompt");
  assert.equal(loose.suite, false);
  assert.equal(loose.delta, null);
  assert.deepEqual(radarMatrix([]), { versions: [], rows: [] });
});

test("radarMatrix: an unstamped run with the same prompt joins the suite group", () => {
  const rows = [
    RS({ run_id: "s1" }),
    // Same prompt, provider, model and context, recorded before the
    // suite existed. It belongs to the same held-constant group.
    RS({ run_id: "old", suite_prompt: null, wall_ms: 260 }),
    RS({ run_id: "diff", suite_prompt: null, context_mode: "full" }),
  ];
  const m = radarMatrix(rows);
  assert.equal(m.rows.length, 2);
  const sky = m.rows.find((r) => r.label === "sky");
  assert.equal(sky.suite, true);
  assert.equal(sky.cells[VA].n, 2);
  assert.equal(sky.cells[VA].wall_ms, 230);
});

test("radarMatrix: a version with one run earns no delta", () => {
  const rows = RADAR_ROWS.filter((r) => r.run_id !== "5");
  const sky = radarMatrix(rows).rows[0];
  assert.equal(sky.cells[VB].n, 1);
  assert.equal(sky.delta, null);
});

test("radarReport: mechanical summary and method, recorded numbers only", () => {
  const text = radarReport(radarMatrix(RADAR_ROWS), "2026-03-04T10:00:00Z");
  assert.match(text, /^# Muse latency report/m);
  assert.match(text, /Date: 2026-03-04/);
  assert.match(text, /Reporter: \(fill in\)/);
  assert.match(text, /sky: median wall 200 ms -> 500 ms \(\+150%\)/);
  assert.match(text, /Nothing is estimated/);
  assert.match(text, /Not held constant: machine load, network/);
  // Token medians display rounded. Half a token is maths, not a count.
  const halves = radarReport(radarMatrix([
    RS({ run_id: "h1", input_tokens: 1000 }),
    RS({ run_id: "h2", input_tokens: 1001 }),
  ]), "2026-03-04T10:00:00Z");
  assert.ok(!halves.includes("1,000.5"));
  assert.match(halves, /1,001/);
  const empty = radarReport(radarMatrix([]), "2026-03-04T10:00:00Z");
  assert.match(empty, /No prompt has two versions/);
});

test("xrayFirstLanes: biggest recorded lanes first, works without a system lane", () => {
  assert.deepEqual(xrayFirstLanes(xraySeries(XRAY), 2).map((l) => l.lane),
    ["system_base", "context"]);
  // Echo-style trace: no system_base recorded at all.
  const echo = xraySeries([TRACE(0, 39327, 9, [LANE("context", 39318), LANE("history", 9)])]);
  assert.deepEqual(xrayFirstLanes(echo, 2).map((l) => [l.lane, l.bytes]),
    [["context", 39318], ["history", 9]]);
  assert.deepEqual(xrayFirstLanes(xraySeries([]), 2), []);
});

const DIAG_TL = [
  T("2026-01-01T00:00:00.000Z", "runtime.user_intent.accepted accepted"),
  T("2026-01-01T00:03:10.000Z", "runtime.session model_completed", 188550),
];
const DIAG = (over) => ({
  wall_ms: 192586, model_ms: 188550, provider: "meta",
  events: [{ ...E(188550, 29037, 0, 25), retries: 1, stalled_ms: 181140 }],
  split: { model_ms: 188550, tool_ms: 0, approval_ms: 0, muse_ms: 4036 },
  timeline: DIAG_TL, baseline: null, ...over,
});

test("diagnoseRun: stall run reads as buckets then stall finding", () => {
  const d = diagnoseRun(DIAG());
  assert.equal(d.buckets[0].key, "model");
  assert.equal(d.buckets[0].share_pct, 98);
  assert.match(d.verdict, /Most of this run was model time \(98% of wall\)\./);
  assert.equal(d.findings[0].kind, "stalled");
  assert.match(d.findings[0].text, /94% of wall, inside model time/);
  assert.equal(d.findings[0].call, 1);
  assert.equal(d.findings[0].replay_offset_ms, 190000);
  // The fixed context finding follows. One call means no cache story.
  assert.ok(d.findings.some((f) => f.kind === "fixed-context"));
  assert.ok(!d.findings.some((f) => f.kind === "weak-cache"));
  assert.ok(!d.findings.some((f) => f.kind === "dominant-call"));
});

test("diagnoseRun: thresholds fire and stay silent on both sides", () => {
  const grow = (inputs) => diagnoseRun({
    wall_ms: 100000, model_ms: 90000, provider: "meta",
    events: inputs.map((n) => E(1000, n, 0, 10)).reverse(),
    split: { model_ms: 90000, tool_ms: 0, approval_ms: 0, muse_ms: 10000 },
    timeline: [], baseline: null,
  }).findings.some((f) => f.kind === "context-growth");
  assert.equal(grow([4000, 6000, 10000]), true);
  assert.equal(grow([4000, 6000, 7600]), false);
  const dom = (wires) => diagnoseRun({
    wall_ms: 100000, model_ms: wires.reduce((a, b) => a + b, 0), provider: "meta",
    events: wires.map((w) => E(w, 100, 0, 10)).reverse(),
    split: { model_ms: wires.reduce((a, b) => a + b, 0), tool_ms: 0, approval_ms: 0, muse_ms: 0 },
    timeline: [], baseline: null,
  }).findings.some((f) => f.kind === "dominant-call");
  assert.equal(dom([60000, 20000, 20000]), true);
  assert.equal(dom([60000, 40000]), false);
  const usual = (wall, base) => diagnoseRun({
    wall_ms: wall, model_ms: wall, provider: "meta",
    events: [E(wall, 100, 0, 10)],
    split: { model_ms: wall, tool_ms: 0, approval_ms: 0, muse_ms: 0 },
    timeline: [], baseline: base ? { wall_ms: base, count: 4 } : null,
  }).findings.some((f) => f.kind === "slower-than-usual");
  assert.equal(usual(40000, 30000), true);
  assert.equal(usual(33000, 30000), false);
  assert.equal(usual(40000, null), false);
});

test("diagnoseRun: recorded-ms findings rank biggest first, cap holds", () => {
  const d = diagnoseRun(DIAG({
    wall_ms: 100000, model_ms: 40000,
    split: { model_ms: 40000, tool_ms: 5000, approval_ms: 30000, muse_ms: 25000 },
    events: [{ ...E(40000, 29037, 0, 25), retries: 1, stalled_ms: 10000 }],
  }));
  const kinds = d.findings.map((f) => f.kind);
  assert.ok(kinds.indexOf("approval") < kinds.indexOf("muse-overhead"));
  assert.ok(kinds.indexOf("muse-overhead") < kinds.indexOf("stalled"));
  assert.ok(d.findings.length <= 6);
});

test("diagnoseRun: Claude Code runs thin out without invented call detail", () => {
  const d = diagnoseRun({
    wall_ms: 40000, model_ms: 38000, provider: "claude-code",
    events: [{ ...E(null, 1500, 0, null), retries: 0, stalled_ms: null }],
    split: { model_ms: 38000, tool_ms: null, approval_ms: null, muse_ms: null },
    timeline: [], baseline: null,
  });
  assert.equal(d.buckets[0].key, "model");
  assert.deepEqual(d.findings, []);
  assert.deepEqual(diagnoseRun({}).findings, []);
  assert.equal(diagnoseRun({}).verdict, null);
});

const IV = (kind, name, start, dur, wait = 0) => ({
  kind, name,
  start_at: "2026-01-01T00:00:" + String(start).padStart(2, "0") + ".000Z",
  end_at: "2026-01-01T00:00:" + String(start + Math.round(dur / 1000)).padStart(2, "0") + ".000Z",
  duration_ms: dur, wait_ms: wait,
});
const TOOLS = {
  intervals: [
    IV("tool", "bash", 5, 20000, 12000),
    IV("tool", "bash", 30, 21000, 0),
    IV("tool", "read_file", 55, 500),
    IV("approval", "bash", 6, 12000),
  ],
  unclosed_tools: [], unclosed_approvals: [],
};

test("toolTotals: groups by recorded name, slowest single kept", () => {
  const totals = toolTotals(TOOLS);
  assert.equal(totals[0].name, "bash");
  assert.equal(totals[0].total_ms, 41000);
  assert.equal(totals[0].calls, 2);
  assert.equal(totals[0].wait_ms, 12000);
  assert.equal(totals[0].slowest_ms, 21000);
  assert.deepEqual(toolTotals(null), []);
  assert.deepEqual(toolTotals({ intervals: [] }), []);
});

test("diagnoseRun: slowest tool named over threshold, silent under it", () => {
  const base = {
    wall_ms: 100000, model_ms: 50000, provider: "meta",
    events: [E(50000, 1000, 0, 10)],
    split: { model_ms: 50000, tool_ms: 29000, approval_ms: 12000, muse_ms: 9000 },
    timeline: DIAG_TL, baseline: null,
  };
  const d = diagnoseRun({ ...base, intervals: TOOLS });
  const tool = d.findings.find((f) => f.kind === "slowest-tool");
  assert.ok(tool);
  assert.match(tool.text, /^bash took /);
  assert.match(tool.text, /across 2 calls \(41% of wall\)/);
  assert.match(tool.text, /Approval wait inside those calls adds up to/);
  // Evidence starts at the slowest single call, 30 s after step one.
  assert.equal(tool.replay_offset_ms, 30000);
  // The approval finding names its tool now that intervals carry it.
  const appr = d.findings.find((f) => f.kind === "approval");
  assert.match(appr.text, /^Approval wait for bash took /);
  const quiet = diagnoseRun({ ...base, intervals: {
    intervals: [IV("tool", "bash", 5, 900)], unclosed_tools: [], unclosed_approvals: [],
  } });
  assert.ok(!quiet.findings.some((f) => f.kind === "slowest-tool"));
});

test("diagnoseRun: unclosed intervals become a partial note, never a finding", () => {
  const d = diagnoseRun({ ...DIAG(), intervals: {
    intervals: [], unclosed_tools: ["bash"], unclosed_approvals: [],
  } });
  assert.match(d.partial_note, /bash started but never recorded a finish/);
  assert.equal(diagnoseRun(DIAG()).partial_note, null);
});

test("parseReplayStart: numeric offsets clamp, junk becomes zero", () => {
  assert.equal(parseReplayStart("5000", 10000), 5000);
  assert.equal(parseReplayStart("99999", 10000), 10000);
  assert.equal(parseReplayStart("-5", 10000), 0);
  assert.equal(parseReplayStart("abc", 10000), 0);
  assert.equal(parseReplayStart(null, 10000), 0);
  assert.equal(parseReplayStart("5000", 0), 0);
});

// --- Shareable run cards and repro packs -----------------------------
// PAYLOAD mimics the /api/logs shape for the stall run. Events are
// newest first, exactly as the server sends them.

const PAYLOAD = (over) => ({
  selected: "20261025-100503-bc9687",
  sessions: [{
    run_id: "20261025-100503-bc9687", at: "2026-10-25T14:05:03+00:00",
    prompt: "what is 2+2", provider: "meta", model: "muse-wonder-full-1.0",
    context_mode: "full", harness_version: "Muse Code 1.4.13 (1.4.13-R6996.1)",
    status: "completed", calls: 1, wall_ms: 192586, model_ms: 188550,
    input_tokens: 29037, output_tokens: 25,
  }],
  prompt: "what is 2+2", reply: "REPLY-TEXT-HERE", provider: "meta",
  model: "muse-wonder-full-1.0",
  harness_version: "Muse Code 1.4.13 (1.4.13-R6996.1)",
  status: "completed", wall_ms: 192586, model_ms: 188550,
  time_split: { model_ms: 188550, tool_ms: 0, approval_ms: 0, muse_ms: 4036 },
  events: [{ ...E(188550, 29037, 0, 25), model: "muse-wonder-full-1.0", retries: 1, stalled_ms: 181140 }],
  timeline: DIAG_TL, errors: [], xray: [],
  intervals: { intervals: [], unclosed_tools: [], unclosed_approvals: [] },
  ...over,
});

test("runCard: stall run carries identity, verdict and stall finding", () => {
  const card = runCard(PAYLOAD());
  assert.match(card, /^# Run card: 20261025-100503-bc9687/m);
  assert.match(card, /meta\/muse-wonder-full-1\.0/);
  assert.match(card, /Status: completed/);
  assert.match(card, /Most of this run was model time \(98% of wall\)\./);
  assert.match(card, /94% of wall, inside model time/);
  assert.match(card, /Input tokens: 29,037/);
  assert.match(card, /Recorded data only/);
});

test("runCard: reply stays off the card and no path or command leaks", () => {
  const card = runCard(PAYLOAD());
  assert.ok(!card.includes("REPLY-TEXT-HERE"));
  assert.ok(!card.includes("/Users/"));
  assert.ok(!card.includes("muse exec"));
});

test("runCard: long prompt truncates on the card with a plain note", () => {
  const long = "x".repeat(500);
  const card = runCard(PAYLOAD({ prompt: long }));
  assert.ok(!card.includes(long));
  assert.match(card, /truncated/);
  assert.ok(card.includes("x".repeat(100)));
});

test("runCard: fence-hostile prompt cannot break out of its fence", () => {
  const card = runCard(PAYLOAD({ prompt: "# not a heading\n```\nboom" }));
  assert.ok(card.includes("````"));
  const lines = card.split("\n");
  const at = lines.indexOf("# not a heading");
  assert.ok(at > 0 && lines[at - 1].startsWith("````"));
});

test("runCard: no-events run shows dashes and plain words, no verdict", () => {
  const card = runCard(PAYLOAD({
    events: [], wall_ms: null, model_ms: null, time_split: {},
    sessions: [{ run_id: "20261025-100503-bc9687", at: "2026-10-25T14:05:03+00:00", prompt: "what is 2+2", provider: "meta", model: "m1", status: "failed", calls: 0 }],
  }));
  assert.match(card, /No calls were recorded/);
  assert.ok(card.includes("–"));
  assert.ok(!card.includes("Most of this run"));
});

test("runCard: running run says so and skips diagnosis", () => {
  const card = runCard(PAYLOAD({ status: "running" }));
  assert.match(card, /Run in progress/);
  assert.ok(!card.includes("Most of this run"));
});

test("runCard: empty payload degrades to plain words, never crashes", () => {
  assert.match(runCard({}), /No run selected/);
  assert.match(runCard(null), /No run selected/);
});

test("runCard: usual baseline line appears with 3 earlier matches", () => {
  const earlier = [1, 2, 3].map((n) => ({
    run_id: "earlier-" + n, at: "2026-10-24T14:05:03+00:00",
    prompt: "what is 2+2", provider: "meta", model: "muse-wonder-full-1.0",
    context_mode: "full", status: "completed", calls: 1,
    wall_ms: 8000, model_ms: 7000, overhead_ms: 1000,
    input_tokens: 29000, output_tokens: 20,
  }));
  const base = PAYLOAD();
  const card = runCard({ ...base, sessions: [...base.sessions, ...earlier] });
  assert.match(card, /usual 8\.0 s/);
});

test("selectedRunFacts: matches the inputs Overview assembles by hand", () => {
  const f = selectedRunFacts(PAYLOAD());
  assert.equal(f.sel.run_id, "20261025-100503-bc9687");
  assert.equal(f.wall, 192586);
  assert.equal(f.modelTotal, 188550);
  assert.equal(f.hasEvents, true);
  assert.equal(f.isRunning, false);
  assert.match(f.diag.verdict, /98% of wall/);
  assert.equal(selectedRunFacts(PAYLOAD({ status: "running" })).diag, null);
  assert.equal(selectedRunFacts({}).hasEvents, false);
});

test("reproPack: embeds the card body, full prompt and full reply", () => {
  const pack = reproPack(PAYLOAD());
  assert.match(pack, /^# Repro pack: 20261025-100503-bc9687/m);
  assert.match(pack, /## Run card/);
  assert.match(pack, /Most of this run was model time \(98% of wall\)\./);
  assert.match(pack, /## Prompt in full/);
  assert.match(pack, /## Reply/);
  assert.ok(pack.includes("REPLY-TEXT-HERE"));
  const long = "y".repeat(500);
  assert.ok(reproPack(PAYLOAD({ prompt: long })).includes(long));
});

test("reproPack: rerun command rebuilt from recorded fields only", () => {
  const pack = reproPack(PAYLOAD());
  assert.ok(pack.includes('./run-muse --provider meta --model muse-wonder-full-1.0 "what is 2+2"'));
  assert.ok(!pack.includes("--minimal"));
  assert.ok(!pack.includes("/Users/"));
  assert.ok(!pack.includes("muse exec"));
  const base = PAYLOAD();
  const minimal = reproPack({
    ...base,
    sessions: [{ ...base.sessions[0], context_mode: "minimal" }],
  });
  assert.ok(minimal.includes("--minimal"));
  const quoted = reproPack(PAYLOAD({ prompt: 'say "hi" and pay $5' }));
  assert.ok(quoted.includes('\\"hi\\"'));
  assert.ok(quoted.includes("\\$5"));
  const watched = reproPack({
    ...base,
    sessions: [{ ...base.sessions[0], context_mode: "interactive" }],
  });
  assert.match(watched, /interactive session/);
  assert.ok(!watched.includes("./run-muse --provider"));
});

test("reproPack: per-call table is chronological with dash discipline", () => {
  const pack = reproPack(PAYLOAD());
  assert.match(pack, /\| Call \| Model \| Model time \| Input \| Output \| Cached \| Reasoning \| Retries \| Stalled \|/);
  assert.match(pack, /\| 1 \| muse-wonder-full-1\.0 \| 3m 8\.6 s \| 29,037 \| 25 \| 0 \| – \| 1 \| 3m 1\.1 s \|/);
  const two = reproPack(PAYLOAD({
    events: [
      { ...E(2000, 500, 0, 5), model: "m1", retries: 0, stalled_ms: null },
      { ...E(1000, 300, 0, 3), model: "m1", retries: 0, stalled_ms: null },
    ],
  }));
  assert.match(two, /\| 1 \| m1 \| 1\.0 s \| 300 \|/);
  assert.match(two, /\| 2 \| m1 \| 2\.0 s \| 500 \|/);
});

test("reproPack: xray, tools, errors and timeline sections ride along", () => {
  const pack = reproPack(PAYLOAD({
    xray: XRAY,
    intervals: {
      intervals: [{ kind: "tool", name: "bash", duration_ms: 9000, wait_ms: 0, start_at: "2026-10-25T14:05:10+00:00" }],
      unclosed_tools: ["write_file"], unclosed_approvals: [],
    },
    errors: [{ at: "2026-10-25T14:08:15+00:00", operation: "20261025-100503-bc9687", error_type: "exit 1" }],
  }));
  assert.match(pack, /## Context X-ray/);
  assert.match(pack, /1,000 bytes/);
  assert.match(pack, /user message was 10 bytes/);
  assert.match(pack, /## Tools/);
  assert.match(pack, /bash: 1 call/);
  assert.match(pack, /write_file/);
  assert.match(pack, /## Errors/);
  assert.match(pack, /exit 1/);
  assert.match(pack, /## Timeline/);
  assert.match(pack, /runtime\.session model_completed/);
});

test("reproPack: long timeline truncates with a plain count note", () => {
  const rows = Array.from({ length: 250 }, (_, i) => T("2026-01-01T00:00:00.000Z", "op " + i, null, i));
  const pack = reproPack(PAYLOAD({ timeline: rows }));
  assert.match(pack, /Timeline truncated at 200 of 250 rows/);
  assert.ok(!pack.includes("| op 249 |"));
});

test("reproPack: empty payload and missing reply degrade in plain words", () => {
  assert.match(reproPack({}), /No run selected/);
  assert.match(reproPack(PAYLOAD({ reply: "" })), /No reply recorded/);
});
