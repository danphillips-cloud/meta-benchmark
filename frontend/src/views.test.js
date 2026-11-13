import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

// Compile the actual views with the existing build dependency. Keep React
// external so the renderer and views share the same hooks runtime.
const src = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(src, "../.view-tests-"));
after(() => rm(temp, { recursive: true, force: true }));
const output = join(temp, "views.mjs");
await build({
  stdin: { contents: `export { default as Runs, summaryText } from "./views/Runs.jsx";
    export { default as Timeline } from "./views/Timeline.jsx";
    export { default as Overview } from "./views/Overview.jsx";`, resolveDir: src },
  outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic",
  external: ["react", "react/*", "react-dom/*", "react-router"],
});
const { Runs, summaryText, Timeline, Overview } = await import(pathToFileURL(output));
const session = { run_id: "codex-test", provider: "codex", model: "test-model",
  prompt: "ping", status: "completed", context_mode: "minimal", calls: null,
  wall_ms: 42, model_ms: null, overhead_ms: null, cost_usd: null,
  input_tokens: 11640, output_tokens: 5 };
const data = { selected: session.run_id, provider: "codex", model: "test-model",
  prompt: "ping", reply: "pong", status: "completed", events: [], timeline: [],
  sessions: [session], time_split: {}, xray: [], errors: [] };
const render = (View, payload) => renderToStaticMarkup(React.createElement(MemoryRouter,
  {}, React.createElement(View, { data: payload, sessionValue: session.run_id })));

test("Runs summary and selector render unknown calls as a dash", () => {
  const text = summaryText(data);
  assert.match(text, /– call\(s\)/);
  assert.doesNotMatch(text, /null call|undefined call/);
  const html = render(Runs, data);
  assert.match(html, /– call\(s\)/);
  assert.doesNotMatch(html, /null call|undefined call/);
});

test("finished Codex Timeline explains absent per-call telemetry", () => {
  const html = render(Timeline, data);
  assert.match(html, /Codex does not report per-call model timing/);
  assert.doesNotMatch(html, /No model calls yet/);
});

test("running Codex Overview does not promise live totals", () => {
  const running = { ...data, status: "running", sessions: [{ ...session, status: "running" }] };
  const html = render(Overview, running);
  assert.match(html, /Token totals and the reply appear when it finishes/);
  assert.doesNotMatch(html, /Totals grow as calls land/);
});
