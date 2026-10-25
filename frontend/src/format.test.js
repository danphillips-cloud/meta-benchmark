import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeFilterChips, buildRunsQuery, chartData, compareSessions, filterSessions, fmt, fmtSec, hasSharedFilters, inDateRange,
  median, overviewScope, parseRunsQuery, parseSharedFilters, runMode, showBrush,
} from "./format.js";

const S = (over) => ({
  run_id: "r1", at: "2026-01-01T00:00:00+00:00", prompt: "hello world",
  provider: "meta", model: "muse-wonder-1.0", compare_mode: null,
  status: "completed", calls: 2, wall_ms: 100, model_ms: 80,
  overhead_ms: 20, ...over,
});

test("honesty basics: missing renders as –, median skips nulls", () => {
  assert.equal(fmt(null), "–");
  assert.equal(median([null, 10, 20]), 15);
  assert.equal(median([null]), null);
});

test("runMode defaults single runs to 'single'", () => {
  assert.equal(runMode(S({})), "single");
  assert.equal(runMode(S({ compare_mode: "meta" })), "meta");
  assert.equal(runMode(null), "single");
});

test("parseRunsQuery defaults and validation", () => {
  assert.deepEqual(parseRunsQuery(new URLSearchParams("")),
    { q: "", provider: "", model: "", status: "", mode: "", sort: "at", dir: "desc", from: "", to: "" });
  assert.deepEqual(parseRunsQuery(new URLSearchParams("q=hi&provider=meta&sort=wall_ms&dir=asc")),
    { q: "hi", provider: "meta", model: "", status: "", mode: "", sort: "wall_ms", dir: "asc", from: "", to: "" });
  // Unknown sort/dir fall back to the safe default, never crash.
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).sort, "at");
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).dir, "desc");
  assert.equal(parseRunsQuery("status=failed").status, "failed");
});

test("buildRunsQuery round-trips through parseRunsQuery", () => {
  const state = { q: "hi there", provider: "meta", model: "m1", status: "failed", mode: "claude", sort: "wall_ms", dir: "asc", from: "2026-01-01", to: "2026-01-31" };
  assert.deepEqual(parseRunsQuery(buildRunsQuery(state)), state);
  // Defaults stay out of the URL so the plain /runs link is clean.
  assert.equal(buildRunsQuery({ q: "", provider: "", model: "", status: "", mode: "", sort: "at", dir: "desc" }).toString(), "");
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
