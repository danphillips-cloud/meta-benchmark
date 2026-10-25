import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { buildRunsQuery, explainLines, fmt, fmtDur, fmtDurParts, fmtMs, liveStateText, localTime, median, overviewScope, parseRunsQuery, parseSharedFilters, usualBaseline } from "../format.js";
import { PerCallChart, RecentRunsChart } from "../components/charts.jsx";
import { FilterBar } from "../components/filters.jsx";
import { Chip, StatIcon, StatusPill } from "../components/widgets.jsx";
import { copyText } from "../api.js";

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function inline(s) {
  return esc(s).split(/`([^`]+)`/).map((part, i) => {
    if (i % 2 === 1) return "<code>" + part + "</code>";
    return part
      .replace(/\[([^\]]+)\]\((?:&lt;([^&]+)&gt;|([^)\s]+))\)/g, (m, label, angle, plain) => {
        const target = String(angle || plain || "").replace(/"/g, "&quot;");
        if (/^https?:\/\//i.test(target))
          return '<a href="' + target + '" target="_blank" rel="noopener">' + label + "</a>";
        return '<code class="replyPath" title="' + target + '">' + label + "</code>";
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }).join("");
}

// Markdown-ish reply rendering, ported 1:1 (input is escaped first).
export function replyHtml(text) {
  const blocks = text.split(/```/);
  let html = "";
  const cellsOf = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const isSep = (row) => /^\s*\|?[\s:|-]+\|?\s*$/.test(row) && row.includes("-") && row.includes("|");
  blocks.forEach((block, bi) => {
    if (bi % 2 === 1) { html += "<pre>" + esc(block.replace(/^\w*\n/, "")) + "</pre>"; return; }
    const lines = block.split(/\n/);
    let listTag = "";
    const closeList = () => { if (listTag) { html += "</" + listTag + ">"; listTag = ""; } };
    for (let li = 0; li < lines.length; li++) {
      const trimmed = lines[li].trim();
      if (trimmed.includes("|") && li + 1 < lines.length && isSep(lines[li + 1])) {
        closeList();
        const headCells = cellsOf(trimmed);
        html += '<div class="replyTable"><table><thead><tr>' + headCells.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
        li += 2;
        while (li < lines.length && lines[li].trim().includes("|") && lines[li].trim() !== "") {
          html += "<tr>" + cellsOf(lines[li]).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
          li++;
        }
        li--;
        html += "</tbody></table></div>";
        continue;
      }
      const head = trimmed.match(/^(#{1,4})\s+(.*)$/);
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (head) {
        closeList();
        const tag = head[1].length <= 2 ? "h3" : "h4";
        html += "<" + tag + ">" + inline(head[2]) + "</" + tag + ">";
      } else if (bullet || numbered) {
        const wanted = bullet ? "ul" : "ol";
        if (listTag !== wanted) { closeList(); html += "<" + wanted + ">"; listTag = wanted; }
        html += "<li>" + inline((bullet || numbered)[1]) + "</li>";
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closeList(); html += "<hr>";
      } else if (quote) {
        closeList(); html += "<blockquote>" + inline(quote[1]) + "</blockquote>";
      } else if (trimmed === "") {
        closeList();
      } else {
        closeList();
        html += "<p>" + inline(trimmed) + "</p>";
      }
    }
    closeList();
  });
  return html;
}

function StatCard({ label, icon, value, unit, detail, title, hero }) {
  return (
    <div className={"stat" + (hero ? " hero" : "")}>
      <div className="statTop"><small>{label}</small><StatIcon kind={icon} /></div>
      <div className="big" title={title}><span>{value}</span>{unit ? <> <span className="unit">{unit}</span></> : null}</div>
      <div className="detail">{detail}</div>
    </div>
  );
}

export default function Overview({ data, onSelect, onGoto }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const runsState = parseRunsQuery(searchParams);
  const shared = parseSharedFilters(searchParams);
  const updateFilters = (patch) => setSearchParams(buildRunsQuery({ ...runsState, ...patch }), { replace: true });
  const providers = [...new Set((data.sessions || []).map((s) => s.provider).filter(Boolean))].sort();
  const models = [...new Set((data.sessions || []).map((s) => s.model).filter(Boolean))].sort();
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const reply = data.reply || "";
  useEffect(() => { setReplyExpanded(false); }, [reply]);

  const sel = (data.sessions || []).find((s) => s.run_id === data.selected) || {};
  const events = data.events || [];
  const wires = events.map((e) => e["wire_ms"]).filter((v) => v != null);
  const hasEvents = events.length > 0;
  const modelTotal = hasEvents ? (data.model_ms ?? wires.reduce((a, b) => a + b, 0)) : null;
  const wall = hasEvents ? data.wall_ms : null;
  const overhead = (wall != null && modelTotal != null) ? Math.max(0, wall - modelTotal) : null;
  const share = (v) => (v != null && wall) ? Math.round(v / wall * 100) + "% of wall" : "–";
  const wallP = fmtDurParts(wall), modelP = fmtDurParts(modelTotal), overP = fmtDurParts(overhead);
  const inSum = events.reduce((a, e) => a + (e["gen_ai.usage.input_tokens"] ?? 0), 0);
  const cacheSum = events.reduce((a, e) => a + (e["gen_ai.usage.cached_tokens"] ?? 0), 0);
  const cacheShare = inSum ? Math.round(cacheSum / inSum * 100) + "% cached" : "cache –";

  const notes = [];
  if (data.provider === "claude-code")
    notes.push("Claude Code does not report per-call time or per-call output tokens, so Wire, Slowest and last-call Output show –. Model total is the API time it reports for the whole run.");
  if (data.status === "running")
    notes.push("Run in progress — totals grow as calls land.");
  if (["failed", "interrupted", "timeout"].includes(data.status || sel.status))
    notes.push("This run did not complete. It stays in Runs, but it is excluded from all medians.");
  if ((data.status || sel.status) === "needs_approval")
    notes.push("This run was stopped because it waited for approval. It stays in Runs, but it is excluded from all medians.");

  const elapsed = data.status === "running" && data.elapsed_ms != null ? fmtDur(data.elapsed_ms) + " elapsed" : null;
  const scope = overviewScope(data, shared);
  const split = data.time_split || {};
  const retryTotal = events.reduce((a, e) => a + (e["retries"] || 0), 0);
  const stalledTotal = events.reduce((a, e) => a + (e["stalled_ms"] || 0), 0);
  const toolP = fmtDurParts(split.tool_ms ?? null), apprP = fmtDurParts(split.approval_ms ?? null), museP = fmtDurParts(split.muse_ms ?? null);
  const whatLines = explainLines({ wall_ms: wall, model_ms: modelTotal, provider: data.provider || sel.provider, events, split });
  const baseline = usualBaseline(sel.run_id ? sel : null, data.sessions || []);
  const usualWall = baseline && baseline.wall_ms != null ? " · usual " + fmtDur(baseline.wall_ms) : "";
  const usualModel = baseline && baseline.model_ms != null ? " · usual " + fmtDur(baseline.model_ms) : "";
  const usualOver = baseline && baseline.overhead_ms != null ? " · usual " + fmtDur(baseline.overhead_ms) : "";

  // Medians by provider/model, completed runs only.
  const groups = new Map();
  scope.runs.forEach((s) => {
    const key = (s.provider || "?") + "/" + (s.model || "?");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  const rows = [...groups.entries()].map(([key, all]) => {
    const runs = all.filter((s) => s.status === "completed");
    return {
      key, all: all.length, ok: runs.length,
      wall: median(runs.map((s) => s.wall_ms)), model: median(runs.map((s) => s.model_ms)),
      over: median(runs.map((s) => s.overhead_ms)),
    };
  }).filter((r) => r.ok > 0).sort((a, b) => b.ok - a.ok || a.key.localeCompare(b.key));
  const wallRows = rows.filter((r) => r.ok > 0 && r.wall != null && r.wall > 0);
  const fastestKeys = new Set();
  let fastRatio = null;
  if (wallRows.length >= 2) {
    const minWall = Math.min(...wallRows.map((r) => r.wall));
    const maxWall = Math.max(...wallRows.map((r) => r.wall));
    if (maxWall > minWall) {
      fastRatio = maxWall / minWall;
      wallRows.filter((r) => r.wall === minWall).forEach((r) => fastestKeys.add(r.key));
    }
  }

  const long = reply.length > 700;
  return (
    <section data-view-panel="overview">
      <section className="panel" aria-label="Selected run">
        <div className="label">Selected run</div>
        <div id="latestPrompt">{data.prompt || "–"}</div>
        <div id="runChips">
          <StatusPill status={data.status || sel.status} extra={elapsed} />
          {(data.provider || data.model) ? <Chip text={(data.provider || "?") + "/" + (data.model || "?")} cls="model" /> : null}
          <Chip text={"version " + (sel.harness_version ?? data.harness_version ?? "–")} />
          {sel.context_mode ? <Chip text={sel.context_mode + " context"} /> : null}
          {sel.comparison_id ? <Chip text={"compare set " + sel.comparison_id + (sel.round ? " · round " + sel.round : "")} /> : null}
          {sel.at ? <Chip text={localTime(sel.at)} title={data.selected ? "Run " + data.selected : undefined} /> : null}
        </div>
        <div id="error" role="alert" style={{ display: (data.errors && data.errors.length) ? "block" : "none" }}>
          {(data.errors && data.errors.length)
            ? "Latest session error: " + data.errors.map((e) => (e.operation || "call") + " — " + (e.error_type || "failed")).join("; ")
            : ""}
        </div>
      </section>
      {(data.status === "running" || sel.status === "running") && data.live_state ? (
        <div className={"liveBanner" + (data.live_state.state === "waiting for approval" ? " warn" : "")} role="status">
          {"Live: " + liveStateText(data.live_state)}
        </div>
      ) : null}
      <div className="stats">
        <StatCard label="Wall time" icon="wall" value={wallP[0]} unit={wallP[1].trim()} title={wall == null ? "" : fmtMs(wall) + " ms"}
          detail={(hasEvents ? fmt(events.length) + (events.length === 1 ? " call" : " calls") + " · " + (data.status || sel.status || "unknown") : "–") + usualWall} />
        <StatCard label="Model time" icon="model" value={modelP[0]} unit={modelP[1].trim()} title={modelTotal == null ? "" : fmtMs(modelTotal) + " ms"}
          detail={retryTotal > 0 && stalledTotal > 0
            ? fmtDur(stalledTotal) + " stalled before retry"
            : (data.provider === "claude-code" && modelTotal != null ? share(modelTotal) + " · reported API time" : share(modelTotal)) + usualModel} />
        <StatCard label="Tools" icon="overhead" value={toolP[0]} unit={toolP[1].trim()} title={split.tool_ms == null ? "" : fmtMs(split.tool_ms) + " ms"}
          detail={share(split.tool_ms ?? null)} />
        <StatCard label="Approval wait" icon="overhead" value={apprP[0]} unit={apprP[1].trim()} title={split.approval_ms == null ? "" : fmtMs(split.approval_ms) + " ms"}
          detail={share(split.approval_ms ?? null)} />
        <StatCard label="Muse" icon="overhead" hero value={museP[0]} unit={museP[1].trim()} title={split.muse_ms == null ? "" : fmtMs(split.muse_ms) + " ms"}
          detail={share(split.muse_ms ?? null)} />
        <div className="stat">
          <div className="statTop"><small>Input tokens</small><StatIcon kind="input" /></div>
          <div className="big"><span>{fmt(sel.input_tokens)}</span></div>
          <div className="detail">{"Output " + fmt(sel.output_tokens) + " · " + cacheShare}</div>
        </div>
      </div>
      <p className="note" style={{ display: notes.length ? "" : "none" }}>{notes.join(" ")}</p>
      {whatLines.length ? (
        <section className="panel" aria-label="What happened" style={{ marginTop: 12 }}>
          <div className="panelHead"><div><div className="pt">What happened</div><div className="ps">Recorded data only · no estimates</div></div></div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
            {whatLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </section>
      ) : null}
      <section className="panel" aria-label="Per-call breakdown" style={{ marginTop: 12 }}>
        <div className="panelHead"><div><div className="pt">Per-call breakdown</div><div className="ps">Model time and input tokens per call, in order</div></div></div>
        <PerCallChart events={events} provider={data.provider || sel.provider} />
        {(data.provider || sel.provider) !== "claude-code" ? <div className="legend"><span><span className="sw swModel"></span>model time</span>{retryTotal > 0 ? <span><span className="sw swStalled"></span>stalled</span> : null}<span>line = input tokens</span></div> : null}
      </section>
      <section className="panel" aria-label="Shared filters" style={{ marginTop: 12, padding: "12px 16px" }}>
        <div className="label" style={{ marginBottom: 8 }}>Filters · shared with Runs</div>
        <FilterBar state={shared} providers={providers} models={models} onChange={updateFilters} />
      </section>
      <div className="panelGrid">
        <div className="colStack">
          <section className="panel">
            <div className="panelHead"><div><div className="pt">Recent runs</div><div className="ps">{"Model time vs overhead, per run · " + scope.label}</div></div><button className="viewAll" type="button" onClick={() => onGoto("runs")}>View all →</button></div>
            <RecentRunsChart data={data} onSelect={onSelect} scope={scope} />
            <div className="legend"><span><span className="sw swModel"></span>model time</span><span><span className="sw swOver"></span>overhead</span><span>outlined = selected run</span></div>
          </section>
          <section className="panel">
            <div className="panelHead"><div><div className="pt">Reply</div><div className="ps">{reply ? fmt(reply.length) + " characters" : "No reply recorded"}</div></div>
              {reply ? <button className="btn" type="button" style={{ marginLeft: "auto", flex: "none" }} onClick={async () => { await copyText(reply); setCopyStatus("Copied."); setTimeout(() => setCopyStatus(""), 2000); }}>Copy reply</button> : null}
            </div>
            {reply
              ? <div className={"reply" + (long && !replyExpanded ? " collapsed" : "")} dangerouslySetInnerHTML={{ __html: replyHtml(reply) }} />
              : <div className="reply"><p className="emptyReply">No reply recorded for this run.</p></div>}
            {long ? <button className="btn" style={{ marginTop: 8 }} onClick={() => setReplyExpanded(!replyExpanded)}>{replyExpanded ? "Show less" : "Show full reply"}</button> : null}
            <span className="empty" style={{ marginLeft: 8 }}>{copyStatus}</span>
          </section>
        </div>
        <div className="colStack">
          <section className="panel">
            <div className="panelHead"><div><div className="pt">Medians by provider/model</div><div className="ps">{scope.label + " · Completed only · count is completed / total"}</div></div><button className="viewAll" type="button" onClick={() => onGoto("compare")}>View all →</button></div>
            <div>
              {!groups.size ? <span className="empty">No runs yet.</span>
                : !rows.length ? <span className="empty">No completed runs in scope.</span>
                : rows.map((r) => {
                  const wp = fmtDurParts(r.wall);
                  return (
                    <div className="medianRow" key={r.key}>
                      <div className="who">
                        <div className="name">{r.key}
                          {fastestKeys.has(r.key) ? <span className="badgeFast" title="Lowest median wall time in this scope">fastest</span> : null}
                        </div>
                        {fastestKeys.has(r.key) ? <span className="fastRatio" title="Median wall time vs the slowest group in this scope">{fastRatio.toFixed(1) + "× faster"}</span> : null}
                        <div className="sub">{"Model " + fmtDur(r.model) + " · Overhead " + fmtDur(r.over) + " · " + r.ok + "/" + r.all + " ok"}</div>
                      </div>
                      <div className="wall" title={r.wall == null ? "" : fmtMs(r.wall) + " ms"}>{wp[0]}<span className="unit">{wp[1]}</span></div>
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
