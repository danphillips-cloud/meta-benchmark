import React, { useState } from "react";
import { Link } from "react-router";
import { fastestOf, fmtCost, fmtDur, fmtMs, legKey, localTime, median, raceProgress, shortText, visibleCost } from "../format.js";
import { RunsBarChart } from "../components/charts.jsx";
import { StatusPill, pickableProps } from "../components/widgets.jsx";

function CompareSet({ data, onSelect }) {
  const selected = (data.sessions || []).find((s) => s.run_id === data.selected);
  if (!selected || !selected.comparison_id) {
    return <div className="panel empty">The selected run is not part of a compare set. Pick a run from a compare set in Runs to see its legs here.</div>;
  }
  const inSet = (data.sessions || []).filter((s) => s.comparison_id === selected.comparison_id);
  const byLeg = new Map();
  [...inSet].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    .forEach((s) => { if (!byLeg.has(legKey(s))) byLeg.set(legKey(s), []); byLeg.get(legKey(s)).push(s); });
  const legs = [...byLeg.keys()];
  const rounds = [...new Set(inSet.map((s) => s.round ?? null))]
    .sort((a, b) => (a == null ? 0 : a) - (b == null ? 0 : b));
  const modeNames = { meta: "Meta vs Meta", claude: "Meta vs Claude", custom: "Custom" };
  const modeName = modeNames[selected.compare_mode];
  const title = "One prompt, " + legs.length + (legs.length === 1 ? " way" : " ways")
    + (modeName ? " · " + modeName : "") + " · set " + selected.comparison_id
    + " · " + rounds.length + (rounds.length === 1 ? " round" : " rounds");
  const prompts = [...new Set(inSet.map((s) => s.prompt || ""))];
  const allRaced = inSet.length > 0 && inSet.every((s) => s.raced);
  const promptLine = (prompts.length === 1
    ? "Same prompt for every leg: “" + shortText(prompts[0], 140) + "”. Run each way in the terminal with ./run-muse --compare …; this panel lines the legs up side by side."
    : "Heads up: legs in this set do not all share one prompt, so treat side-by-side times with care.")
    + (allRaced ? " Legs ran at the same time." : "");
  const racing = raceProgress(inSet, Date.now());
  const wallMeds = legs.map((key) => {
    const done = byLeg.get(key).filter((s) => s.status === "completed");
    return { key, wall: median(done.map((s) => s.wall_ms)), ok: done.length };
  }).filter((x) => x.ok > 0);
  const { fastestKeys, fastRatio } = fastestOf(wallMeds);
  return (
    <section className="panel">
      <div className="panelHead"><div><div className="pt">{title}</div><div className="ps">{promptLine}</div></div></div>
      {racing.length ? (
        <div className="tableWrap" style={{ marginBottom: 12 }}>
          <table>
            <thead><tr><th>Leg running now</th><th className="num">Elapsed</th><th className="num">Calls landed</th><th className="num">Model so far</th><th>Status</th></tr></thead>
            <tbody>
              {racing.map((r) => (
                <tr key={r.run_id}>
                  <td>{r.leg}</td>
                  <td className="num">{fmtDur(r.elapsed_ms)}</td>
                  <td className="num">{r.calls == null ? "–" : r.calls}</td>
                  <td className="num">{fmtDur(r.model_ms)}</td>
                  <td><StatusPill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <RunsBarChart runs={inSet} selected={data.selected} onSelect={onSelect} />
      <div className="legend"><span><span className="sw swModel"></span>model time</span><span><span className="sw swOver"></span>overhead</span><span>outlined = selected run</span></div>
      <div className="tableWrap" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>Provider/Model</th><th>Runs</th><th className="num">Wall</th><th className="num">Model</th><th className="num">Overhead</th><th className="num">TTFT</th><th className="num">Calls</th><th className="num">In</th><th className="num">Out</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {legs.map((key) => {
              const all = byLeg.get(key);
              const runs = all.filter((s) => s.status === "completed");
              const med = (f) => { const v = median(runs.map(f)); return v == null ? "–" : fmtMs(v); };
              const medDur = (f) => fmtDur(median(runs.map(f)));
              const cost = fmtCost(median(runs.map((s) => visibleCost(s))));
              const latest = [...all].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
                .find((s) => s.status === "completed") || [...all].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
              const cells = [key, runs.length + "/" + all.length + " ok", medDur((s) => s.wall_ms), medDur((s) => s.model_ms),
                medDur((s) => s.overhead_ms), medDur((s) => s.ttft_ms), med((s) => s.calls),
                med((s) => s.input_tokens), med((s) => s.output_tokens), cost];
              return (
                <tr key={key} className={"pickable" + (legKey(selected) === key ? " is-selected" : "")} role="button"
                  aria-label={"Open latest " + key + " run in this set"} title="Open this leg's latest run"
                  {...pickableProps(() => { if (latest) onSelect(latest.run_id); })}>
                  {cells.map((v, i) => (
                    <td key={i} className={i >= 2 ? "num" : undefined}>
                      {v}
                      {i === 0 && fastestKeys.has(key) ? (<>
                        <span className="badgeFast" title="Lowest median wall time in this compare set">fastest</span>
                        <span className="fastRatio" title="Median wall time vs the slowest group in this compare set">{fastRatio.toFixed(1) + "× faster"}</span>
                      </>) : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">Table values are medians over completed runs only. Failed and interrupted runs stay in the round table below and in the ok/total count, but never in a median. Click a row or a round cell to open that run.</p>
      <div className="tableWrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Round</th>
              {legs.map((k) => {
                const sample = byLeg.get(k)[0] || {};
                return <th key={k} className="num" title={k}>{(sample.model || "?") + " (" + (sample.provider || "?") + ") · wall"}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {!rounds.length ? <tr><td className="empty">No rounds.</td></tr>
              : rounds.map((r) => {
                const roundRuns = legs
                  .map((k) => byLeg.get(k).find((x) => (x.round ?? null) === r))
                  .filter(Boolean);
                return (
                <tr key={String(r)}>
                  <td>
                    {r == null ? "–" : "Round " + r}
                    {roundRuns.length === 2 ? (
                      <>
                        <br />
                        <Link className="viewAll" to={"/replay/" + encodeURIComponent(roundRuns[0].run_id) + "?vs=" + encodeURIComponent(roundRuns[1].run_id)}>Replay both</Link>
                      </>
                    ) : null}
                  </td>
                  {legs.map((k) => {
                    const s = byLeg.get(k).find((x) => (x.round ?? null) === r);
                    if (!s) return <td key={k} className="num">–</td>;
                    return (
                      <td key={k} className="num">
                        <button type="button" className="btn" style={{ padding: "3px 10px", ...(s.run_id === data.selected ? { borderColor: "var(--accent)" } : {}) }}
                          title={k + " · " + (s.status || "unknown") + " · " + localTime(s.at) + (s.wall_ms == null ? "" : " · " + fmtMs(s.wall_ms) + " ms")}
                          aria-label={"Open " + k + " run from round " + (r ?? "–") + ", status " + (s.status || "unknown")}
                          onClick={() => onSelect(s.run_id)}>{fmtDur(s.wall_ms)}</button>
                        <br />
                        <StatusPill status={s.status} />
                      </td>
                    );
                  })}
                </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Compare({ data, onSelect }) {
  const [compareRun, setCompareRun] = useState("");
  const [compareRun2, setCompareRun2] = useState("");
  const sessions = data.sessions || [];
  const a = sessions.find((s) => s.run_id === data.selected);
  const others = [compareRun, compareRun2]
    .map((id) => sessions.find((s) => s.run_id === id))
    .filter((s, i, arr) => s && a && s.run_id !== a.run_id && arr.indexOf(s) === i);
  const runLabel = (s) => shortText((s.model || s.run_id), 22) + " · " + localTime(s.at).slice(11);
  const metrics = [
    ["Wall", (s) => s.wall_ms, 1], ["Model", (s) => s.model_ms, 1],
    ["Overhead", (s) => s.overhead_ms, 1], ["TTFT", (s) => s.ttft_ms, 1],
    ["Calls", (s) => s.calls], ["Input tokens, run", (s) => s.input_tokens],
    ["Output tokens, run", (s) => s.output_tokens],
    ["Cost", (s) => visibleCost(s)],
    ["Input tokens, last call", (s) => s.last_input_tokens],
    ["Output tokens, last call", (s) => s.last_output_tokens]];
  // Honest delta: – when either side is missing. Never substitute 0.
  const deltaText = (x, y, isDur) => (x == null || y == null) ? "–"
    : ((x - y) > 0 ? "+" : "") + (isDur ? fmtDur(x - y) : fmtMs(x - y));
  const options = () => (
    <>
      <option value="">None</option>
      {sessions.map((s) => <option key={s.run_id} value={s.run_id}>{localTime(s.at) + " · " + shortText(s.prompt || s.run_id, 36)}</option>)}
    </>
  );
  return (
    <section data-view-panel="compare">
      <div className="viewHead"><span className="hint">same prompt across legs, or any runs side by side</span><Link className="viewAll" to="/radar">Version radar →</Link></div>
      <CompareSet data={data} onSelect={onSelect} />
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panelHead"><div><div className="pt">Compare runs manually</div><div className="ps">Selected run plus up to two more</div></div></div>
        <div className="comparePick">
          <label htmlFor="compareSelect">Compare selected with</label>
          <select id="compareSelect" value={compareRun} onChange={(e) => setCompareRun(e.target.value)}>{options()}</select>
          <label htmlFor="compareSelect2">and</label>
          <select id="compareSelect2" value={compareRun2} onChange={(e) => setCompareRun2(e.target.value)}>{options()}</select>
        </div>
        {(!a || !others.length)
          ? <div className="empty">Pick one or two more sessions to compare against the selected run (3 runs side by side).</div>
          : (
            <div>
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th className="num">{"Selected · " + runLabel(a)}</th>
                      {others.flatMap((s) => [<th key={s.run_id + "-h"} className="num">{runLabel(s)}</th>, <th key={s.run_id + "-d"} className="num">Selected − this</th>])}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(([name, f, isDur]) => {
                      const isCost = name === "Cost";
                      const show = (v) => isCost ? fmtCost(v) : isDur ? fmtDur(v) : fmtMs(v);
                      const delta = (x, y) => isCost
                        ? ((x == null || y == null) ? "–" : ((x - y) > 0 ? "+" : (x - y) < 0 ? "-" : "") + fmtCost(Math.abs(x - y)))
                        : deltaText(x, y, isDur);
                      return (
                        <tr key={name}>
                          <td>{name}</td>
                          <td className="num">{show(f(a))}</td>
                          {others.flatMap((s) => [<td key={s.run_id + "-v"} className="num">{show(f(s))}</td>, <td key={s.run_id + "-dv"} className="num">{delta(f(a), f(s))}</td>])}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="note">Deltas are plain differences (selected minus compared), shown as – when a harness did not report that metric. Bigger is not coloured better or worse.</p>
            </div>
          )}
      </section>
    </section>
  );
}
