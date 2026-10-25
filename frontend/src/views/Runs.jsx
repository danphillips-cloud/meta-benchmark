import React, { useState } from "react";
import { fmt, fmtDur, fmtDurParts, fmtMs, localTime, shortText } from "../format.js";
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

export default function Runs({ data, sessionValue, onSessionChange, onSelect, onDelete, sessionSelectRef }) {
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const all = data.sessions || [];
  const providers = [...new Set(all.map((s) => s.provider).filter(Boolean))].sort();
  const q = filter.trim().toLowerCase();
  const shown = all.filter((s) =>
    (!q || (s.prompt || s.run_id || "").toLowerCase().includes(q)) &&
    (!statusFilter || s.status === statusFilter) && (!providerFilter || s.provider === providerFilter));
  const text = summaryText(data);
  return (
    <section data-view-panel="runs">
      <div className="viewHead"><span className="hint">{"showing " + shown.length + " of " + all.length}</span></div>
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
        <input type="search" id="sessionFilter" placeholder="Prompt text…" size="18" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label htmlFor="statusFilter">Status</label>
        <select id="statusFilter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All</option><option value="completed">completed</option><option value="running">running</option><option value="failed">failed</option><option value="interrupted">interrupted</option><option value="timeout">timeout</option>
        </select>
        <label htmlFor="providerFilter">Provider</label>
        <select id="providerFilter" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
          <option value="">All</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <section className="panel runListPanel">
        <div id="runList">
          {!shown.length
            ? <div className="empty" style={{ padding: 12 }}>{all.length ? "No sessions match the filter." : "No sessions yet."}</div>
            : shown.map((s) => {
              const dim = ["failed", "interrupted", "timeout"].includes(s.status);
              const wp = fmtDurParts(s.wall_ms);
              return (
                <button key={s.run_id} type="button" aria-label={"Open run " + (s.prompt || s.run_id)}
                  className={"runRow" + (s.run_id === data.selected ? " is-selected" : "") + (dim ? " dim" : "")}
                  onClick={() => onSelect(s.run_id)}>
                  <div className="main">
                    <div className="runTitle" title={s.prompt || ""}>{s.prompt || s.run_id}</div>
                    <div className="runMeta">
                      <StatusPill status={s.status} />
                      <span>{(s.provider || "?") + "/" + (s.model || "?") + " · " + fmt(s.calls) + (s.calls === 1 ? " call" : " calls") + " · " + localTime(s.at) + (s.comparison_id ? " · set " + s.comparison_id + (s.round ? " r" + s.round : "") : "")}</span>
                    </div>
                  </div>
                  <div className="runWallBox">
                    <div className="runWall" title={s.wall_ms == null ? "" : fmtMs(s.wall_ms) + " ms"}>{wp[0]}<span className="unit">{wp[1]}</span></div>
                    <div className="runWallSub">{"model " + fmtDur(s.model_ms) + " · overhead " + fmtDur(s.overhead_ms)}</div>
                  </div>
                </button>
              );
            })}
        </div>
      </section>
      <details>
        <summary>Sessions summary (text)</summary>
        <div className="panel"><pre id="summaryText">{text}</pre></div>
      </details>
      <button className="btn" style={{ marginTop: 8 }} onClick={async () => { await copyText(text); setCopyStatus("Copied."); setTimeout(() => setCopyStatus(""), 2000); }}>Copy summary</button>
      <span className="empty" style={{ marginLeft: 8 }}>{copyStatus}</span>
    </section>
  );
}
