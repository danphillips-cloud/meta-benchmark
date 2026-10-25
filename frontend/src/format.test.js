import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunsQuery, compareSessions, filterSessions, fmt, median,
  parseRunsQuery, runMode,
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
    { q: "", provider: "", model: "", status: "", mode: "", sort: "at", dir: "desc" });
  assert.deepEqual(parseRunsQuery(new URLSearchParams("q=hi&provider=meta&sort=wall_ms&dir=asc")),
    { q: "hi", provider: "meta", model: "", status: "", mode: "", sort: "wall_ms", dir: "asc" });
  // Unknown sort/dir fall back to the safe default, never crash.
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).sort, "at");
  assert.equal(parseRunsQuery(new URLSearchParams("sort=bogus&dir=sideways")).dir, "desc");
  assert.equal(parseRunsQuery("status=failed").status, "failed");
});

test("buildRunsQuery round-trips through parseRunsQuery", () => {
  const state = { q: "hi there", provider: "meta", model: "m1", status: "failed", mode: "claude", sort: "wall_ms", dir: "asc" };
  assert.deepEqual(parseRunsQuery(buildRunsQuery(state)), state);
  // Defaults stay out of the URL so the plain /runs link is clean.
  assert.equal(buildRunsQuery({ q: "", provider: "", model: "", status: "", mode: "", sort: "at", dir: "desc" }).toString(), "");
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
