import React, { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel, getPaginationRowModel, getSortedRowModel, useLegacyTable,
} from "@tanstack/react-table/legacy";
import {
  RUNS_PAGE_SIZE, buildRunsQuery, compareSessions, filterSessions,
  fmt, fmtDur, localTime, nextRunsSort, parseRunsQuery, runMode, shortText,
} from "../format.js";
import { StatusPill } from "../components/widgets.jsx";
import { copyText } from "../api.js";

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
      + " / out " + fmt(s.last_output_tokens));
  });
  const wall = sessions.reduce((a, s) => a + (s.wall_ms || 0), 0);
  const model = sessions.reduce((a, s) => a + (s.model_ms || 0), 0);
  lines.push("");
  lines.push("Total: " + sessions.length + " session(s) · wall " + fmtDur(wall)
    + " · model " + fmtDur(model) + " · overhead " + fmtDur(wall - model));
  return lines.join("\n");
}

const HEADERS = [
  ["at", "Time", false], ["prompt", "Prompt", false],
  ["provider_model", "Provider/Model", false], ["mode", "Mode", false],
  ["status", "Status", false], ["calls", "Calls", true],
  ["wall_ms", "Wall", true], ["model_ms", "Model", true],
  ["overhead_ms", "Overhead", true],
];

export default function Runs({ data, sessionValue, onSessionChange, onSelect, onDelete, sessionSelectRef }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseRunsQuery(searchParams);
  const [pageIndex, setPageIndex] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const all = data.sessions || [];
  const providers = [...new Set(all.map((s) => s.provider).filter(Boolean))].sort();
  const models = [...new Set(all.map((s) => s.model).filter(Boolean))].sort();
  const modes = [...new Set(all.map((s) => runMode(s)))].sort();

  const update = (patch) => {
    setPageIndex(0);
    setSearchParams(buildRunsQuery({ ...state, ...patch }), { replace: true });
  };
  const cycleSort = (sortId) => update(nextRunsSort(state, sortId));

  // Filter and sort are pure and unit-tested; TanStack owns rendering
  // and paging over the result. Missing values sort last, never as 0.
  const rows = useMemo(() => {
    const filtered = filterSessions(all, state);
    return [...filtered].sort((a, b) => compareSessions(a, b, state.sort, state.dir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, state.q, state.provider, state.model, state.status, state.mode, state.sort, state.dir]);

  const columns = useMemo(() => HEADERS.map(([id, label, num]) => ({
    id,
    header: label,
    accessorFn: (s) => s[id],
    cell: ({ row }) => {
      const s = row.original;
      if (id === "at") return localTime(s.at) || "–";
      if (id === "prompt") return <span title={s.prompt || ""}>{shortText(s.prompt || s.run_id, 72)}</span>;
      if (id === "provider_model") return (s.provider || "?") + "/" + (s.model || "?");
      if (id === "mode") return runMode(s);
      if (id === "status") return <StatusPill status={s.status} />;
      if (id === "calls") return fmt(s.calls);
      return fmtDur(s[id]);
    },
    meta: { num },
  })), []);

  const table = useLegacyTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: { pagination: { pageIndex, pageSize: RUNS_PAGE_SIZE } },
    onPaginationChange: (up) => {
      const next = typeof up === "function" ? up({ pageIndex, pageSize: RUNS_PAGE_SIZE }) : up;
      setPageIndex(next.pageIndex);
    },
  });
  const pageCount = table.getPageCount();
  const text = summaryText(data);
  return (
    <section data-view-panel="runs">
      <div className="viewHead"><span className="hint">{"showing " + rows.length + " of " + all.length}</span></div>
      <div className="toolbar">
        <label htmlFor="sessionSelect">Session</label>
        <select id="sessionSelect" ref={sessionSelectRef} value={sessionValue} onChange={(e) => onSessionChange(e.target.value)}>
          {all.map((s) => (
            <option key={s.run_id} value={s.run_id}>{localTime(s.at) + " · " + shortText(s.prompt || s.run_id, 36) + " · " + s.calls + " call(s)"}</option>
          ))}
        </select>
        <span className="pill model" title="Selected run's provider and model">{(data.provider ? data.provider + "/" : "") + (data.model || "–")}</span>
        <span className="spacer"></span>
        <button className="btn danger" type="button" onClick={onDelete}>Delete session</button>
      </div>
      <div className="filterRow">
        <label htmlFor="sessionFilter">Filter</label>
        <input type="search" id="sessionFilter" placeholder="Prompt text…" size="18" value={state.q} onChange={(e) => update({ q: e.target.value })} />
        <label htmlFor="providerFilter">Provider</label>
        <select id="providerFilter" value={state.provider} onChange={(e) => update({ provider: e.target.value })}>
          <option value="">All</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label htmlFor="modelFilter">Model</label>
        <select id="modelFilter" value={state.model} onChange={(e) => update({ model: e.target.value })}>
          <option value="">All</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="statusFilter">Status</label>
        <select id="statusFilter" value={state.status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">All</option><option value="completed">completed</option><option value="running">running</option><option value="failed">failed</option><option value="interrupted">interrupted</option><option value="timeout">timeout</option>
        </select>
        <label htmlFor="modeFilter">Mode</label>
        <select id="modeFilter" value={state.mode} onChange={(e) => update({ mode: e.target.value })}>
          <option value="">All</option>
          {modes.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
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
            {!rows.length
              ? <tr><td colSpan={HEADERS.length} className="empty">{all.length ? "No sessions match the filter." : "No sessions yet."}</td></tr>
              : table.getRowModel().rows.map((row) => {
                const s = row.original;
                const dim = ["failed", "interrupted", "timeout"].includes(s.status);
                return (
                  <tr key={s.run_id} tabIndex={0}
                    className={"pickable" + (s.run_id === data.selected ? " is-selected" : "") + (dim ? " dim" : "")}
                    aria-label={"Open run " + (s.prompt || s.run_id)} title={s.prompt || ""}
                    onClick={() => onSelect(s.run_id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.run_id); } }}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className={cell.column.columnDef.meta && cell.column.columnDef.meta.num ? "num" : undefined}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <div className="pagerRow">
        <button className="btn" type="button" disabled={pageIndex <= 0} onClick={() => setPageIndex(pageIndex - 1)}>← Prev</button>
        <span className="empty">{"Page " + Math.min(pageIndex + 1, Math.max(pageCount, 1)) + " of " + Math.max(pageCount, 1) + " · " + rows.length + " run(s)"}</span>
        <button className="btn" type="button" disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex(pageIndex + 1)}>Next →</button>
      </div>
      <details>
        <summary>Sessions summary (text)</summary>
        <div className="panel"><pre id="summaryText">{text}</pre></div>
      </details>
      <button className="btn" type="button" style={{ marginTop: 8 }} onClick={async () => { await copyText(text); setCopyStatus("Copied."); setTimeout(() => setCopyStatus(""), 2000); }}>Copy summary</button>
      <span className="empty" style={{ marginLeft: 8 }}>{copyStatus}</span>
    </section>
  );
}
