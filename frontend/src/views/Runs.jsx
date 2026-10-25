import React, { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  columnFilteringFeature, createFilteredRowModel, createPaginatedRowModel,
  createSortedRowModel, flexRender, rowPaginationFeature, rowSortingFeature,
  tableFeatures, useTable,
} from "@tanstack/react-table";
import {
  RUNS_PAGE_SIZE, buildRunsQuery, compareSessions,
  fmt, fmtDur, inDateRange, legKey, localTime, nextRunsSort, parseRunsQuery, runMode, shortText,
} from "../format.js";
import { StatusPill } from "../components/widgets.jsx";
import { FilterBar } from "../components/filters.jsx";
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
  ["status", "Status", false], ["harness_version", "Version", false],
  ["calls", "Calls", true],
  ["wall_ms", "Wall", true], ["model_ms", "Model", true],
  ["overhead_ms", "Overhead", true],
];

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
});

const SORT_ACCESSOR = {
  at: (s) => s.at || undefined,
  prompt: (s) => s.prompt || undefined,
  provider_model: (s) => legKey(s),
  mode: (s) => runMode(s),
  status: (s) => s.status || undefined,
  harness_version: (s) => s.harness_version || undefined,
  calls: (s) => (s.calls == null ? undefined : s.calls),
  wall_ms: (s) => (s.wall_ms == null ? undefined : s.wall_ms),
  model_ms: (s) => (s.model_ms == null ? undefined : s.model_ms),
  overhead_ms: (s) => (s.overhead_ms == null ? undefined : s.overhead_ms),
};

export default function Runs({ data, sessionValue, onSessionChange, onSelect, onDelete, sessionSelectRef }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseRunsQuery(searchParams);
  const [pageIndex, setPageIndex] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const all = data.sessions || [];
  const providers = [...new Set(all.map((s) => s.provider).filter(Boolean))].sort();
  const models = [...new Set(all.map((s) => s.model).filter(Boolean))].sort();
  const modes = [...new Set(all.map((s) => runMode(s)))].sort();
  const versions = [...new Set(all.map((s) => s.harness_version).filter(Boolean))].sort();

  const update = (patch) => {
    setPageIndex(0);
    setSearchParams(buildRunsQuery({ ...state, ...patch }), { replace: true });
  };
  const cycleSort = (sortId) => update(nextRunsSort(state, sortId));

  const columns = useMemo(() => HEADERS.map(([id, label, num]) => ({
    id,
    header: label,
    accessorFn: SORT_ACCESSOR[id],
    sortUndefined: "last",
    sortingFn: (rowA, rowB, columnId) => compareSessions(rowA.original, rowB.original, columnId, "asc"),
    filterFn: (row, columnId, value) => {
      const s = row.original;
      if (columnId === "prompt") {
        const q = String(value || "").trim().toLowerCase();
        return !q || (s.prompt || s.run_id || "").toLowerCase().includes(q);
      }
      if (columnId === "provider_model") {
        const v = value || {};
        return (!v.provider || s.provider === v.provider) && (!v.model || s.model === v.model);
      }
      if (columnId === "status") return s.status === value;
      if (columnId === "mode") return runMode(s) === value;
      if (columnId === "harness_version") return s.harness_version === value;
      if (columnId === "at") {
        const v = value || {};
        return inDateRange(s.at, v.from || "", v.to || "");
      }
      return true;
    },
    cell: ({ row }) => {
      const s = row.original;
      if (id === "at") return localTime(s.at) || "–";
      if (id === "prompt") return <span title={s.prompt || ""}>{shortText(s.prompt || s.run_id, 72)}</span>;
      if (id === "provider_model") return (s.provider || "?") + "/" + (s.model || "?");
      if (id === "mode") return runMode(s);
      if (id === "status") return <StatusPill status={s.status} />;
      if (id === "harness_version") return s.harness_version || "–";
      if (id === "calls") return fmt(s.calls);
      return fmtDur(s[id]);
    },
    meta: { num },
  })), []);

  const columnFilters = useMemo(() => {
    const f = [];
    if (state.q) f.push({ id: "prompt", value: state.q });
    if (state.provider || state.model) f.push({ id: "provider_model", value: { provider: state.provider, model: state.model } });
    if (state.status) f.push({ id: "status", value: state.status });
    if (state.mode) f.push({ id: "mode", value: state.mode });
    if (state.version) f.push({ id: "harness_version", value: state.version });
    if (state.from || state.to) f.push({ id: "at", value: { from: state.from, to: state.to } });
    return f;
  }, [state.q, state.provider, state.model, state.status, state.mode, state.version, state.from, state.to]);

  const sorting = useMemo(() => [{ id: state.sort, desc: state.dir === "desc" }], [state.sort, state.dir]);

  const table = useTable({
    features,
    data: all,
    columns,
    getRowId: (s) => s.run_id,
    state: {
      sorting,
      columnFilters,
      pagination: { pageIndex, pageSize: RUNS_PAGE_SIZE },
    },
    onSortingChange: (up) => {
      const next = typeof up === "function" ? up(sorting) : up;
      const first = next && next[0];
      if (!first) update({ ...{ sort: "at", dir: "desc" } });
      else update({ sort: first.id, dir: first.desc ? "desc" : "asc" });
    },
    onColumnFiltersChange: (up) => {
      const next = typeof up === "function" ? up(columnFilters) : up;
      const patch = { q: "", provider: "", model: "", status: "", mode: "", version: "", from: "", to: "" };
      (next || []).forEach((f) => {
        if (f.id === "prompt") patch.q = String(f.value || "");
        else if (f.id === "provider_model") { patch.provider = (f.value && f.value.provider) || ""; patch.model = (f.value && f.value.model) || ""; }
        else if (f.id === "status") patch.status = String(f.value || "");
        else if (f.id === "mode") patch.mode = String(f.value || "");
        else if (f.id === "harness_version") patch.version = String(f.value || "");
        else if (f.id === "at") { patch.from = (f.value && f.value.from) || ""; patch.to = (f.value && f.value.to) || ""; }
      });
      update(patch);
    },
    onPaginationChange: (up) => {
      const next = typeof up === "function" ? up({ pageIndex, pageSize: RUNS_PAGE_SIZE }) : up;
      setPageIndex(next.pageIndex);
    },
  });
  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const text = summaryText(data);
  return (
    <section data-view-panel="runs">
      <div className="viewHead"><span className="hint">{"showing " + filteredCount + " of " + all.length}</span></div>
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
            {!filteredCount
              ? <tr><td colSpan={HEADERS.length} className="empty">{all.length ? "No sessions match the filter." : "No sessions yet."}</td></tr>
              : table.getRowModel().rows.map((row) => {
                const s = row.original;
                const dim = ["failed", "interrupted", "timeout", "needs_approval"].includes(s.status);
                return (
                  <tr key={s.run_id} tabIndex={0}
                    className={"pickable" + (s.run_id === data.selected ? " is-selected" : "") + (dim ? " dim" : "")}
                    aria-label={"Open run " + (s.prompt || s.run_id)} title={s.prompt || ""}
                    onClick={() => onSelect(s.run_id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.run_id); } }}>
                    {row.getAllCells().map((cell) => (
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
        <span className="empty">{"Page " + Math.min(pageIndex + 1, Math.max(pageCount, 1)) + " of " + Math.max(pageCount, 1) + " · " + filteredCount + " run(s)"}</span>
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
