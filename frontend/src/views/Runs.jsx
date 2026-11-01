import React, { useState } from "react";
import { useSearchParams } from "react-router";
import {
  DID_NOT_COMPLETE, RUNS_PAGE_SIZE, allowanceHoverText, buildRunsQuery, compareSessions, costReason, costUnit, filterOptions, filterSessions,
  fmt, fmtAllowance, fmtCost, fmtDur, legKey, localTime, nextRunsSort, parseRunsQuery, planUsageTotalText, runCostText, runMode, shortText, visibleCost,
} from "../format.js";
import { CopyButton, StatusPill, pickableProps } from "../components/widgets.jsx";
import { FilterBar } from "../components/filters.jsx";

export function summaryText(data) {
  const sessions = [...(data.sessions || [])].reverse();
  if (!sessions.length) return "No sessions yet.";
  const lines = ["meta-benchmark summary (" + (data.provider ? data.provider + "/" : "") + (data.model || "unknown model") + ")", ""];
  sessions.forEach((s) => {
    lines.push(localTime(s.at) + "  " + (s.prompt || s.run_id));
    lines.push("  " + (s.provider || "?") + "/" + (s.model || "?") + " (" + (s.context_mode || "full") + " context)"
      + (s.comparison_id ? " · compare set " + s.comparison_id : "") + (s.status ? " · " + s.status : ""));
    lines.push("  " + s.calls + " call(s) · wall " + fmtDur(s.wall_ms) + " · model " + fmtDur(s.model_ms)
      + " · overhead " + fmtDur(s.overhead_ms) + " · last in " + fmt(s.last_input_tokens)
      + " / out " + fmt(s.last_output_tokens) + " · cost " + runCostText(s));
  });
  // Totals cover only runs that recorded each figure, and say so.
  const withWall = sessions.filter((s) => s.wall_ms != null);
  const withModel = sessions.filter((s) => s.model_ms != null);
  const wall = withWall.reduce((a, s) => a + s.wall_ms, 0);
  const model = withModel.reduce((a, s) => a + s.model_ms, 0);
  const allTimed = sessions.every((s) => s.wall_ms != null && s.model_ms != null);
  const priced = sessions.map((s) => visibleCost(s)).filter((v) => v != null);
  const cost = priced.reduce((a, v) => a + v, 0);
  const allowText = planUsageTotalText(sessions);
  lines.push("");
  lines.push("Total: " + sessions.length + " session(s) · wall "
    + (withWall.length ? fmtDur(wall) + " over " + withWall.length + " timed run(s)" : "–")
    + " · model " + (withModel.length ? fmtDur(model) + " over " + withModel.length + " timed run(s)" : "–")
    + " · overhead " + (allTimed && sessions.length ? fmtDur(wall - model) : "–")
    + " · recorded cost " + (priced.length ? fmtCost(cost) + " over " + priced.length + " priced run(s)" : "–")
    + " · plan usage " + allowText);
  return lines.join("\n");
}

const HEADERS = [
  ["at", "Time", false], ["prompt", "Prompt", false],
  ["provider_model", "Provider/Model", false], ["mode", "Mode", false],
  ["status", "Status", false], ["harness_version", "Version", false],
  ["calls", "Calls", true],
  ["wall_ms", "Wall", true], ["model_ms", "Model", true],
  ["overhead_ms", "Overhead", true],
  ["cost_usd", "Cost", true],
];

function cellValue(s, id) {
  if (id === "at") return localTime(s.at) || "–";
  if (id === "prompt") return <span title={s.prompt || ""}>{shortText(s.prompt || s.run_id, 72)}</span>;
  if (id === "provider_model") return legKey(s);
  if (id === "mode") return runMode(s);
  if (id === "status") return <StatusPill status={s.status} />;
  if (id === "harness_version") return s.harness_version || "–";
  if (id === "calls") return fmt(s.calls);
  if (id === "cost_usd") return (<span title={costUnit(s) === "allowance" && fmtAllowance(s.allowance_delta) !== "–" ? allowanceHoverText(s) : costReason(s)}>{runCostText(s)}</span>);
  return fmtDur(s[id]);
}

export default function Runs({ data, sessionValue, onSessionChange, onSelect, onDelete }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseRunsQuery(searchParams);
  const [pageIndex, setPageIndex] = useState(0);
  const all = data.sessions || [];
  const { providers, models } = filterOptions(all);
  const modes = [...new Set(all.map((s) => runMode(s)))].sort();
  const versions = [...new Set(all.map((s) => s.harness_version).filter(Boolean))].sort();

  const update = (patch) => {
    setPageIndex(0);
    setSearchParams(buildRunsQuery({ ...state, ...patch }), { replace: true });
  };
  const cycleSort = (sortId) => update(nextRunsSort(state, sortId));

  const filtered = filterSessions(all, state);
  const sorted = [...filtered].sort((a, b) => compareSessions(a, b, state.sort, state.dir));
  const pageCount = Math.ceil(sorted.length / RUNS_PAGE_SIZE);
  const page = sorted.slice(pageIndex * RUNS_PAGE_SIZE, (pageIndex + 1) * RUNS_PAGE_SIZE);
  const text = summaryText(data);
  return (
    <section data-view-panel="runs">
      <div className="viewHead"><span className="hint">{"showing " + filtered.length + " of " + all.length}</span></div>
      <div className="toolbar">
        <label htmlFor="sessionSelect">Session</label>
        <select id="sessionSelect" value={sessionValue} onChange={(e) => onSessionChange(e.target.value)}>
          {all.map((s) => (
            <option key={s.run_id} value={s.run_id}>{localTime(s.at) + " · " + shortText(s.prompt || s.run_id, 36) + " · " + s.calls + " call(s)"}</option>
          ))}
        </select>
        <span className="pill model" title="Selected run's provider and model">{(data.provider ? data.provider + "/" : "") + (data.model || "–")}</span>
        <span className="spacer"></span>
        <button className="btn danger" type="button" onClick={onDelete}>Delete session</button>
      </div>
      <FilterBar state={state} providers={providers} models={models} onChange={update} extra={(
        <>
          <label htmlFor="statusFilter">Status</label>
          <select id="statusFilter" value={state.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">All</option><option value="completed">completed</option><option value="running">running</option><option value="failed">failed</option><option value="interrupted">interrupted</option><option value="timeout">timeout</option><option value="needs_approval">needs_approval</option>
          </select>
          <label htmlFor="modeFilter">Mode</label>
          <select id="modeFilter" value={state.mode} onChange={(e) => update({ mode: e.target.value })}>
            <option value="">All</option>
            {modes.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label htmlFor="versionFilter">Version</label>
          <select id="versionFilter" value={state.version} onChange={(e) => update({ version: e.target.value })}>
            <option value="">All</option>
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </>
      )} />
      {page.some((s) => fmtAllowance(s.allowance_delta) !== "–") ? (
        <p className="hint">Muse runs show how much of your plan's usage limits they used.</p>
      ) : null}
      <div className="tableWrap">
        <table className="runsTable">
          <thead>
            <tr>
              {HEADERS.map(([id, label, num]) => {
                const active = state.sort === id;
                const arrow = active ? (state.dir === "asc" ? " ▲" : " ▼") : "";
                return (
                  <th key={id} className={(num ? "num " : "") + "sortable"} aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : undefined}>
                    <button type="button" className="sortBtn" onClick={() => cycleSort(id)} title={"Sort by " + label}>{label + arrow}</button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!filtered.length
              ? <tr><td colSpan={HEADERS.length} className="empty">{all.length ? "No sessions match the filter." : "No sessions yet."}</td></tr>
              : page.map((s) => {
                const dim = DID_NOT_COMPLETE.includes(s.status);
                return (
                  <tr key={s.run_id}
                    className={"pickable" + (s.run_id === data.selected ? " is-selected" : "") + (dim ? " dim" : "")}
                    aria-label={"Open run " + (s.prompt || s.run_id)} title={s.prompt || ""}
                    {...pickableProps(() => onSelect(s.run_id))}>
                    {HEADERS.map(([id, , num]) => (
                      <td key={id} className={num ? "num" : undefined}>{cellValue(s, id)}</td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <div className="pagerRow">
        <button className="btn" type="button" disabled={pageIndex <= 0} onClick={() => setPageIndex(pageIndex - 1)}>← Prev</button>
        <span className="empty">{"Page " + Math.min(pageIndex + 1, Math.max(pageCount, 1)) + " of " + Math.max(pageCount, 1) + " · " + filtered.length + " run(s)"}</span>
        <button className="btn" type="button" disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex(pageIndex + 1)}>Next →</button>
      </div>
      <details>
        <summary>Sessions summary (text)</summary>
        <div className="panel"><pre id="summaryText">{text}</pre></div>
      </details>
      <span style={{ marginTop: 8, display: "inline-block" }}><CopyButton text={text} label="Copy summary" /></span>
    </section>
  );
}
