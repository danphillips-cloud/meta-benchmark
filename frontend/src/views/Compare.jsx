import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { fetchLogs } from "../api.js";
import { comparisonHref, samePromptRuns, fastestOf, wallStats, fmtAllowance, fmtCost, fmtDur, fmtMs, legKey, localTime, median, metricSummary, rangeText, outputSpeed, fmtSpeed, deltaTone, taskCheckText, planDeltaText, raceProgress, runCostText, shortText, visibleCost } from "../format.js";
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
    ? "Same prompt for every leg: “" + shortText(prompts[0], 140) + "”. Run each way in the terminal with ./run-muse --compare … This panel lines the legs up side by side."
    : "Heads up: legs in this set do not all share one prompt, so treat side-by-side times with care.")
    + (allRaced ? " Legs ran at the same time." : "");
  const racing = raceProgress(inSet, Date.now());
  const wallMeds = legs.map((key) => {
    const done = byLeg.get(key).filter((s) => s.status === "completed");
    return { key, ...wallStats(done), ok: done.length };
  }).filter((x) => x.ok > 0);
  const { fastestKeys, fastRatio, note: fastestNote } = fastestOf(wallMeds);
  return (
    <section className="panel">
      <div className="panelHead"><div><div className="pt">{title}</div><div className="ps">{promptLine}</div></div></div>
      {inSet.some((s) => fmtAllowance(s.allowance_delta) !== "–") ? (
        <p className="hint">Muse runs show how much of your plan's usage limits they used.</p>
      ) : null}
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
          <thead>
            <tr>
              <th>Provider/Model</th><th>Runs</th><th className="num">Wall</th><th className="num">Model</th>
              <th className="num">Overhead</th><th className="num">TTFT</th><th className="num">Calls</th><th className="num">In</th>
              <th className="num">Out</th><th className="num" title="Output tokens per second of model time">Out speed</th><th className="num">Cost</th><th>Configured task checks</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((key) => {
              const all = byLeg.get(key);
              const runs = all.filter((s) => s.status === "completed");
              const observation = (f, format) => {
                const stat = metricSummary(runs, f);
                return format(stat.median) + " (n=" + stat.n + ")";
              };
              const med = (f) => observation(f, fmtMs);
              // Durations and speed also show their recorded range.
              const withRange = (f, format) => {
                const range = rangeText(metricSummary(runs, f), format);
                return <>{observation(f, format)}{range ? <><br /><span className="hint" title="Lowest and highest recorded value">{range}</span></> : null}</>;
              };
              const medDur = (f) => withRange(f, fmtDur);
              const usd = metricSummary(runs, visibleCost);
              const allowMedian = {
                window: metricSummary(runs, (s) => s.allowance_delta?.window),
                weekly: metricSummary(runs, (s) => s.allowance_delta?.weekly),
              };
              const cost = usd.median != null ? fmtCost(usd.median) + " (n=" + usd.n + ")" : fmtAllowance({
                window: allowMedian.window.median, weekly: allowMedian.weekly.median,
              }, {
                window: allowMedian.window.median === 0, weekly: allowMedian.weekly.median === 0,
              }) + " (n=" + allowMedian.window.n
                + "/" + allowMedian.weekly.n + ")";
              const newestFirst = [...all].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
              const latest = newestFirst.find((s) => s.status === "completed") || newestFirst[0];
              const cells = [key, runs.length + "/" + all.length + " completed", medDur((s) => s.wall_ms), medDur((s) => s.model_ms),
                medDur((s) => s.overhead_ms), medDur((s) => s.ttft_ms), med((s) => s.calls),
                med((s) => s.input_tokens), med((s) => s.output_tokens), withRange(outputSpeed, fmtSpeed), cost,
                all.filter((s) => s.task_validation?.status === "passed").length + " passed / "
                  + all.filter((s) => s.task_validation?.status === "failed").length + " failed / "
                  + all.filter((s) => !["passed", "failed"].includes(s.task_validation?.status)).length + " not checked"];
              return (
                <tr key={key} className={"pickable" + (legKey(selected) === key ? " is-selected" : "")} role="button"
                  aria-label={"Open latest " + key + " run in this set"} title="Open this leg's latest run"
                  {...pickableProps(() => { if (latest) onSelect(latest.run_id); })}>
                  {cells.map((v, i) => (
                    <td key={i} className={i >= 2 && i < cells.length - 1 ? "num" : undefined}>
                      {v}
                      {i === 0 && fastestKeys.has(key) ? (<>
                        <span className="badgeFast" title="Lowest median wall time, and its slowest run beat every other leg's fastest. Task checks may not have passed">fastest completed</span>
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
      {fastestNote ? <p className="note">{fastestNote}</p> : null}
      <p className="note">
        Table values are medians over completed runs only.
        Failed and interrupted runs stay in the round table below and in the completed/total count, but never in a median.
        Completion means the execution ended successfully, not that the task passed.
        Each n counts recorded values for that metric.
        The line under a time or speed is its lowest and highest recorded value.
        Out speed is output tokens per second of model time.
        Plan usage n shows short-term/weekly observations.
        Click a row or a round cell to open that run.
      </p>
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
                    {roundRuns.length >= 2 && roundRuns.length <= 3 &&
                      <><br /><Link className="viewAll" to={comparisonHref(roundRuns.map((s) => s.run_id))}>Compare runs</Link></>}
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

function compareRunLabel(run) {
  return legKey(run) + " · " + localTime(run.at) + " · " + run.run_id.slice(-6);
}

function Reply({ id, status }) {
  const [result, setResult] = useState({ text: "Loading reply…" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({ text: "Loading reply…" });
    fetchLogs(id).then((d) => {
      if (active) setResult({ text: d.selected === id ? d.reply || "No reply recorded." : "Run unavailable." });
    }).catch(() => {
      if (active) setResult({ text: "Could not load reply.", failed: true });
    });
    return () => { active = false; };
  }, [id, status, attempt]);
  return <><pre>{result.text}</pre>{result.failed && <button className="btn" onClick={() => setAttempt(attempt + 1)}>Retry</button>}</>;
}

function Outputs({ runs }) {
  const [open, setOpen] = useState(false);
  const shared = runs.every((r) => r.prompt === runs[0].prompt);
  return <div className="comparisonOutputs">
    <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? "Hide prompts and replies" : "Show prompts and replies"}
    </button>
    {open && <>
      {shared && <div><h3>Shared prompt</h3><pre>{runs[0].prompt || "No prompt recorded."}</pre></div>}
      <div className="outputColumns">{runs.map((r) => <section key={r.run_id}>
        <h3>{legKey(r)}</h3><small>{localTime(r.at)} · {r.run_id}</small>
        {!shared && <><h4>Prompt</h4><pre>{r.prompt || "No prompt recorded."}</pre></>}
        <h4>Reply</h4><Reply id={r.run_id} status={r.status} />
      </section>)}</div>
    </>}
  </div>;
}

export default function Compare({ data, onSelect }) {
  const [params] = useSearchParams();
  const { setId } = useParams();
  const navigate = useNavigate();
  const sessions = data.sessions || [];
  const ids = [...new Set(params.getAll("pick"))].slice(0, 3);
  const anchor = ids[0] || data.selected;
  const a = sessions.find((s) => s.run_id === anchor);
  const others = ids.slice(1).map((id) => sessions.find((s) => s.run_id === id)).filter(Boolean);
  const same = samePromptRuns(a, sessions);
  const sets = [...new Map(sessions.filter((s) => s.comparison_id).map((s) => [s.comparison_id, s])).values()];
  const change = (index, id) => {
    const next = [anchor, ...ids.slice(1)];
    next[index] = id;
    navigate(comparisonHref(next));
  };
  const metrics = [
    ["Task checks", (s) => taskCheckText(s)],
    ["Wall", (s) => s.wall_ms, 1, "lower"], ["Model", (s) => s.model_ms, 1, "lower"],
    ["Overhead", (s) => s.overhead_ms, 1, "lower"], ["TTFT", (s) => s.ttft_ms, 1, "lower"],
    ["Calls", (s) => s.calls], ["Input tokens, run", (s) => s.input_tokens],
    ["Output tokens, run", (s) => s.output_tokens],
    ["Output speed", (s) => outputSpeed(s), 0, "higher"],
    ["Cost", (s) => visibleCost(s), 0, "lower"],
    ["Input tokens, last call", (s) => s.last_input_tokens],
    ["Output tokens, last call", (s) => s.last_output_tokens]];
  // Honest delta: – when either side is missing. Never substitute 0.
  const deltaText = (x, y, isDur) => (x == null || y == null) ? "–"
    : ((x - y) > 0 ? "+" : "") + (isDur ? fmtDur(x - y) : fmtMs(x - y));
  const options = (current) => sessions.filter((s) => s.run_id === current
    || (s.run_id !== anchor && !ids.includes(s.run_id))).map((s) =>
      <option key={s.run_id} value={s.run_id}>{shortText(s.prompt, 48) + " · " + compareRunLabel(s)}</option>);
  return (
    <section data-view-panel="compare">
      <div className="viewHead"><span className="hint">same prompt across legs, or any runs side by side</span><Link className="viewAll" to="/radar">Version radar →</Link></div>
      <div className="toolbar">
        <Link className="btn" to="/runs">Find runs to compare</Link>
        {sets.length > 0 && <label>Comparison sets <select value={setId || ""}
          onChange={(e) => navigate(e.target.value ? "/compare/" + encodeURIComponent(e.target.value) : "/compare")}>
          <option value="">Select a set</option>
          {sets.map((s) => <option key={s.comparison_id} value={s.comparison_id}>{shortText(s.prompt, 60)} · {s.comparison_id}</option>)}
        </select></label>}
      </div>
      {setId && <CompareSet data={data} onSelect={onSelect} />}
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panelHead"><div><div className="pt">Compare recorded runs</div>
          {a && <div className="ps">{compareRunLabel(a)}<br />{shortText(a.prompt, 160)}</div>}
        </div></div>
        {ids.some((id) => !sessions.some((s) => s.run_id === id)) &&
          <p className="note">A run in this comparison is unavailable.</p>}
        {a && <div className="comparePick">
          {same.some((r) => !ids.includes(r.run_id)) && others.length < 2 &&
            <label>More runs with this prompt <select value="" onChange={(e) => change(others.length + 1, e.target.value)}>
              <option value="">Choose a matching run</option>
              {same.filter((r) => !ids.includes(r.run_id)).map((r) => <option key={r.run_id} value={r.run_id}>{compareRunLabel(r)}</option>)}
            </select></label>}
          {[1, 2].map((i) => <label key={i}>{"Comparison run " + i}
            <select id={i === 1 ? "compareSelect" : "compareSelect2"}
              value={ids[i] || ""} onChange={(e) => change(i, e.target.value)}>
              <option value="">Choose a run</option>{options(ids[i])}
            </select>
          </label>)}
        </div>}
        {(!a || !others.length)
          ? <div className="empty">Choose two or three runs from Runs, or add a comparison run above.</div>
          : (
            <div>
              <Outputs runs={[a, ...others]} />
              {[a, ...others].some((s) => fmtAllowance(s.allowance_delta) !== "–") ? (
                <p className="hint">Muse runs show how much of your plan's usage limits they used.</p>
              ) : null}
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th className="num">{"Selected · " + compareRunLabel(a)}</th>
                      {others.flatMap((s) => [<th key={s.run_id + "-h"} className="num">{compareRunLabel(s)}</th>, <th key={s.run_id + "-d"} className="num">Selected − this</th>])}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(([name, f, isDur, better]) => {
                      const isCost = name === "Cost";
                      const isTask = name === "Task checks";
                      const isSpeed = name === "Output speed";
                      const show = (v, s) => isTask ? v : isSpeed ? fmtSpeed(v) : isCost ? runCostText(s) : isDur ? fmtDur(v) : fmtMs(v);
                      const delta = (x, y, sa, sb) => isTask ? "–" : isSpeed
                        ? ((x == null || y == null) ? "–" : ((x - y) > 0 ? "+" : "") + fmtSpeed(x - y))
                        : isCost
                        ? ((x != null && y != null)
                          ? ((x - y) > 0 ? "+" : (x - y) < 0 ? "-" : "") + fmtCost(Math.abs(x - y))
                          : (planDeltaText(sa, sb) ?? "–"))
                        : deltaText(x, y, isDur);
                      return (
                        <tr key={name}>
                          <td>{name}</td>
                          <td className="num">{show(f(a), a)}</td>
                          {others.flatMap((s) => [<td key={s.run_id + "-v"} className="num">{show(f(s), s)}</td>, <td key={s.run_id + "-dv"} className={"num " + deltaTone(f(a), f(s), better)}>{delta(f(a), f(s), a, s)}</td>])}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="note">Deltas are plain differences (selected minus compared), shown as – when a harness did not report that metric. Green means the selected run did better on that metric, and red means worse. Lower is better for time and cost, and higher is better for output speed. Token and call counts are not coloured.</p>
            </div>
          )}
      </section>
    </section>
  );
}
