import React, { useEffect, useState } from "react";
import { Link } from "react-router";
import { fmt, fmtDur, fmtDurParts, localTime, shortText } from "../format.js";
import { PerCallChart } from "../components/charts.jsx";

function DurValue({ value }) {
  const p = fmtDurParts(value);
  return <><strong>{p[0]}</strong> <span className="unit">{p[1].trim()}</span></>;
}

export default function Timeline({ data }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [data.selected]);
  const events = data.events || [];
  const sel = (data.sessions || []).find((s) => s.run_id === data.selected) || {};
  const vals = events.map((e) => e["wire_ms"]);
  const wires = vals.filter((v) => v != null);
  const latest = events[0];
  const showChart = events.length > 0 && !vals.every((v) => v == null);
  const tl = data.timeline || [];
  const tLong = tl.length > 15;
  return (
    <section data-view-panel="timeline">
      <div className="viewHead"><span className="hint">{data.selected ? shortText(data.prompt || data.selected, 60) + " · " + ((data.provider || "?") + "/" + (data.model || "?")) : ""}</span></div>
      <section className="panel">
        <div className="panelHead"><div><div className="pt">Per-call model time</div><div className="ps">oldest → newest · stalled time shown on retried calls</div></div>{data.selected ? <span style={{ display: "flex", gap: 14, marginLeft: "auto", flex: "none" }}><Link className="viewAll" to={"/replay/" + encodeURIComponent(data.selected)}>Replay this run →</Link><Link className="viewAll" to={"/xray/" + encodeURIComponent(data.selected)}>X-ray this run →</Link></span> : null}</div>
        {showChart ? <PerCallChart events={events} provider={data.provider} /> : null}
        {!showChart ? <p className="note">{data.provider === "claude-code" ? "Claude Code does not report per-call time, so there is no per-call chart for this run. Its model total (reported API time) is on Overview." : "No model calls yet."}</p> : null}
        <div className="statlets">
          <div className="statlet"><span>{"Model time, last call" + (data.provider ? " (" + data.provider + ")" : "")}</span><DurValue value={latest ? latest["wire_ms"] : null} /></div>
          <div className="statlet"><span>Slowest call</span><DurValue value={wires.length ? Math.max(...wires) : null} /></div>
          <div className="statlet"><span>TTFT</span><DurValue value={sel.ttft_ms} /></div>
          <div className="statlet"><span>Input, last call</span><strong>{latest ? fmt(latest["gen_ai.usage.input_tokens"]) : "–"}</strong></div>
          <div className="statlet"><span>Output, last call</span><strong>{latest ? fmt(latest["gen_ai.usage.output_tokens"]) : "–"}</strong></div>
        </div>
      </section>
      <details>
        <summary>Model calls (table, newest first)</summary>
        <div className="tableWrap">
          <table>
            <thead><tr><th className="num">#</th><th>Model</th><th className="num">Model time</th><th className="num">In</th><th className="num">Cached</th><th className="num">Out</th></tr></thead>
            <tbody>
              {!events.length
                ? <tr><td colSpan={6} className="empty">No calls yet.</td></tr>
                : events.map((ev, idx) => (
                  <tr key={idx}>
                    <td className="num">{fmt(events.length - idx)}</td>
                    <td>{ev.model}</td>
                    <td className="num">{fmtDur(ev["wire_ms"])}</td>
                    <td className="num">{fmt(ev["gen_ai.usage.input_tokens"])}</td>
                    <td className="num">{fmt(ev["gen_ai.usage.cached_tokens"])}</td>
                    <td className="num">{fmt(ev["gen_ai.usage.output_tokens"])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panelHead"><div><div className="pt">Full timeline</div><div className="ps">Every step, oldest first. The middle column is time until the next recorded step, not that step's own work. Real model time is the Model time column on model_completed rows (bold).</div></div></div>
        <div className={"tableWrap timelineWrap" + (tLong && !expanded ? " collapsed" : "")}>
          <table>
            <thead><tr><th>At</th><th>Operation (full)</th><th className="num">To next step</th><th className="num">Model time</th><th>Status</th></tr></thead>
            <tbody>
              {!tl.length
                ? <tr><td colSpan={5} className="empty">Nothing yet.</td></tr>
                : tl.map((ev, i) => {
                  const status = ev.ok === false ? "FAILED " + (ev.error_type || "") : (ev.ok === true ? "ok" : "–");
                  return (
                    <tr key={i} className={String(ev.operation || "").includes("model_completed") ? "modelRow" : undefined}>
                      <td>{localTime(ev.at) || "–"}</td>
                      <td className="mono">{ev.operation ?? "–"}</td>
                      <td className="num">{fmtDur(ev.duration_ms)}</td>
                      <td className="num">{fmtDur(ev["wire_ms"])}</td>
                      <td style={ev.ok === false ? { color: "var(--bad)" } : undefined}>{status}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {tLong ? <button className="btn" style={{ marginTop: 10 }} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show full timeline"}</button> : null}
      </section>
    </section>
  );
}
