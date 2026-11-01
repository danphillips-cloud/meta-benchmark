import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { DID_NOT_COMPLETE, allowanceBig, allowanceDetail, allowanceInfoLines, allowanceRows, buildRunsQuery, costNote, costReason, costUnit, fastestOf, filterOptions, fmt, fmtCost, fmtDur, fmtDurParts, fmtMs, fmtResetClock, hasSharedFilters, infoPanelNext, infoPanelOpen, isLongPrompt, legKey, promptPreview, liveStateText, localTime, median, overviewScope, parseRunsQuery, parseSharedFilters, reproPack, runCard, runCostText, selectedRunFacts, sharedFilterCount, shouldCloseFilterPanelOnEscape, syncedFilterPanelOpen, visibleCost } from "../format.js";
import { download } from "../api.js";
import { PerCallChart, RecentRunsChart } from "../components/charts.jsx";
import { FilterBar } from "../components/filters.jsx";
import { ChevronIcon, Chip, CopyButton, CopyIconButton, StatIcon, StatusPill } from "../components/widgets.jsx";

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

// The "Details" overlay beside the Cost card detail line: the two
// readings rows, then the notes. Opens on hover, pins on click or
// tap, closes on Escape, outside click, or focus leaving the
// wrapper. Toggle maths lives in format.js.
function UsageInfo({ sel }) {
  const [state, setState] = useState({ pinned: false, hover: false });
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const open = infoPanelOpen(state);
  const send = (event) => setState((st) => infoPanelNext(st, event));
  useEffect(() => {
    if (!state.pinned) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) send("outside");
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [state.pinned]);
  return (
    <div className="infoWrap" ref={wrapRef}
      onMouseEnter={() => send("hover-in")}
      onMouseLeave={() => send("hover-out")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          send("escape");
          if (btnRef.current) btnRef.current.focus();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) send("blur-out");
      }}>
      <button type="button" className="infoBtn" ref={btnRef}
        aria-expanded={open} aria-controls="usageInfoPanel"
        onClick={() => send("click")}>ⓘ Details</button>
      {open ? (
        <div className="infoPanel" id="usageInfoPanel" role="note" tabIndex={0}>
          <table className="usageTable"><tbody>
            {allowanceRows(sel).map((r) => (r.reason
              ? <tr key={r.label}><td>{r.label}</td><td colSpan={3}>{"– " + r.reason}</td></tr>
              : <tr key={r.label}><td>{r.label}</td><td>{r.range}</td><td>{r.moved}</td><td>{r.resets ? "resets " + r.resets : ""}</td></tr>))}
          </tbody></table>
          {allowanceInfoLines(sel).map((line) => (
            <span key={line}>{line.startsWith("The muse usage command")
              ? <>The <code>muse usage</code> command calls the short-term one Window.</>
              : line}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Overview({ data, onSelect, onGoto }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const runsState = parseRunsQuery(searchParams);
  const shared = parseSharedFilters(searchParams);
  const sharedSignature = JSON.stringify(shared);
  const previousSharedRef = useRef(shared);
  const internalSharedSignatureRef = useRef(null);
  const updateFilters = (patch) => {
    internalSharedSignatureRef.current = JSON.stringify({ ...shared, ...patch });
    setSearchParams(buildRunsQuery({ ...runsState, ...patch }), { replace: true });
  };
  const { providers, models } = filterOptions(data.sessions || []);
  const [filtersOpen, setFiltersOpen] = useState(() => hasSharedFilters(shared));
  const filterToggleRef = useRef(null);
  useEffect(() => {
    const internalChange = internalSharedSignatureRef.current === sharedSignature;
    const nextOpen = syncedFilterPanelOpen(
      previousSharedRef.current, shared, filtersOpen, internalChange);
    previousSharedRef.current = shared;
    if (internalChange) internalSharedSignatureRef.current = null;
    if (nextOpen !== filtersOpen) {
      setFiltersOpen(nextOpen);
      if (!nextOpen && document.activeElement?.closest?.("#overviewSharedFilters")
          && filterToggleRef.current) {
        filterToggleRef.current.focus();
      }
    }
  }, [shared, sharedSignature, filtersOpen]);
  const sharedCount = sharedFilterCount(shared);
  const closeFilters = () => {
    setFiltersOpen(false);
    if (filterToggleRef.current) filterToggleRef.current.focus();
  };
  const onScopeBarKeyDown = (e) => {
    if (e.key === "Escape" && filtersOpen
        && shouldCloseFilterPanelOnEscape(e.target)) {
      e.preventDefault();
      closeFilters();
    }
  };
  const [replyExpanded, setReplyExpanded] = useState(false);
  const reply = data.reply || "";
  useEffect(() => { setReplyExpanded(false); }, [reply]);
  const prompt = data.prompt || "";
  const promptLong = isLongPrompt(prompt);
  const [promptExpanded, setPromptExpanded] = useState(false);
  useEffect(() => { setPromptExpanded(false); }, [prompt]);

  const { sel, events, hasEvents, modelTotal, wall, split, baseline, diag, whatLines, detailLines } = selectedRunFacts(data);
  const share = (v) => (v != null && wall) ? Math.round(v / wall * 100) + "% of wall" : "–";
  const wallP = fmtDurParts(wall), modelP = fmtDurParts(modelTotal);
  const inSum = events.reduce((a, e) => a + (e["gen_ai.usage.input_tokens"] ?? 0), 0);
  const cacheSum = events.reduce((a, e) => a + (e["gen_ai.usage.cached_tokens"] ?? 0), 0);
  // Strict: only a fully recorded run gets a cache share.
  const cacheComplete = events.length > 0
    && events.every((e) => e["gen_ai.usage.input_tokens"] != null
      && e["gen_ai.usage.cached_tokens"] != null);
  const cacheShare = cacheComplete && inSum ? Math.round(cacheSum / inSum * 100) + "% cached" : "cache –";
  const costBig = visibleCost(sel) == null && costUnit(sel) === "allowance"
    ? allowanceBig(sel) : null;
  const showUsageDetails = visibleCost(sel) == null
    && costUnit(sel) === "allowance" && !!sel.allowance_end;
  const costDetail = visibleCost(sel) != null
    ? costNote(sel) + (sel.cost_source === "computed" ? " · input and output only" : "")
    : costBig
      ? allowanceDetail(sel)
      : costUnit(sel) === "allowance" && sel.status === "running" && sel.allowance_start
      ? "Short-term limit was at " + sel.allowance_start.window.used_percent + "% when the run started"
        + (fmtResetClock(sel.allowance_start.window.resets_at_ms)
          ? " (resets at " + fmtResetClock(sel.allowance_start.window.resets_at_ms) + ")" : "")
        + ". How much this run uses lands when it finishes"
      : costReason(sel);

  const notes = [];
  if (data.provider === "claude-code")
    notes.push("Claude Code does not report per-call time or per-call output tokens, so Model time per call, Slowest and last-call Output show –. Model total is the API time it reports for the whole run.");
  if (data.status === "running")
    notes.push("Run in progress. Totals grow as calls land.");
  if (DID_NOT_COMPLETE.includes(data.status || sel.status))
    notes.push((data.status || sel.status) === "needs_approval"
      ? "This run was stopped because it waited for approval. It stays in Runs, but it is excluded from all medians."
      : "This run did not complete. It stays in Runs, but it is excluded from all medians.");

  const elapsed = data.status === "running" && data.elapsed_ms != null ? fmtDur(data.elapsed_ms) + " elapsed" : null;
  const scope = overviewScope(data, shared);
  const retryTotal = events.reduce((a, e) => a + (e["retries"] || 0), 0);
  const stalledTotal = events.reduce((a, e) => a + (e["stalled_ms"] || 0), 0);
  const toolP = fmtDurParts(split.tool_ms ?? null), apprP = fmtDurParts(split.approval_ms ?? null), museP = fmtDurParts(split.muse_ms ?? null);
  const usualWall = baseline && baseline.wall_ms != null ? " · usual " + fmtDur(baseline.wall_ms) : "";
  const usualModel = baseline && baseline.model_ms != null ? " · usual " + fmtDur(baseline.model_ms) : "";

  // Medians by provider/model, completed runs only.
  const groups = new Map();
  scope.runs.forEach((s) => {
    const key = legKey(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  const rows = [...groups.entries()].map(([key, all]) => {
    const runs = all.filter((s) => s.status === "completed");
    return {
      key, all: all.length, ok: runs.length,
      wall: median(runs.map((s) => s.wall_ms)), model: median(runs.map((s) => s.model_ms)),
      over: median(runs.map((s) => s.overhead_ms)),
      cost: median(runs.map((s) => visibleCost(s))),
    };
  }).filter((r) => r.ok > 0).sort((a, b) => b.ok - a.ok || a.key.localeCompare(b.key));
  const wallRows = rows.filter((r) => r.ok > 0);
  const { fastestKeys, fastRatio } = fastestOf(wallRows);

  const long = reply.length > 700;
  return (
    <section data-view-panel="overview">
      <section className="panel" aria-label="Selected run">
        <div className="promptHead">
          <div className="label">Selected run</div>
          {prompt ? (
            <span className="promptTools">
              {promptLong ? <span className="promptMeta">{fmt(prompt.length) + " characters"}</span> : null}
              {!promptLong ? <CopyIconButton text={prompt} label="Copy prompt" /> : null}
            </span>
          ) : null}
        </div>
        {promptLong ? (
          <div className="promptWindowWrap">
            <div
              id="latestPrompt"
              className={"promptLong " + (promptExpanded ? "promptExpanded" : "promptCollapsed")}
            >{promptExpanded ? prompt : promptPreview(prompt)}</div>
            {!promptExpanded ? (
              <button
                className="promptExpandHit"
                type="button"
                aria-label="Expand prompt"
                aria-expanded={false}
                aria-controls="latestPrompt"
                title="Expand prompt"
                onClick={() => setPromptExpanded(true)}
              ><span className="promptChevron"><ChevronIcon expanded={false} /></span></button>
            ) : null}
            <div className="promptActions">
              <CopyIconButton text={prompt} label="Copy prompt" />
              {promptExpanded ? (
                <button
                  className="iconBtn"
                  type="button"
                  aria-label="Collapse prompt"
                  aria-expanded={true}
                  aria-controls="latestPrompt"
                  title="Collapse prompt"
                  onClick={() => setPromptExpanded(false)}
                ><ChevronIcon expanded /></button>
              ) : null}
            </div>
          </div>
        ) : <div id="latestPrompt">{prompt || "–"}</div>}
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
            ? "Latest session error: " + data.errors.map((e) => (e.operation || "call") + ": " + (e.error_type || "failed")).join(". ")
            : ""}
        </div>
        {data.selected ? (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <CopyButton text={runCard(data)} label="Copy run card" />
            <button className="btn" type="button" onClick={() => download("run-card-" + data.selected + ".md", runCard(data), "text/markdown")}>Download card</button>
            <button className="btn" type="button" onClick={() => download("repro-pack-" + data.selected + ".md", reproPack(data), "text/markdown")}>Download repro pack</button>
          </div>
        ) : null}
      </section>
      {(data.status === "running" || sel.status === "running") && data.live_state ? (
        <div className={"liveBanner" + (data.live_state.state === "waiting for approval" ? " warn" : "")} role="status">
          {"Live: " + liveStateText(data.live_state)}
        </div>
      ) : null}
      <div className="stats" data-tour="split">
        <StatCard label="Wall time" icon="wall" value={wallP[0]} unit={wallP[1].trim()} title={wall == null ? "" : fmtMs(wall) + " ms"}
          detail={(hasEvents || wall != null ? fmt(events.length) + (events.length === 1 ? " call" : " calls") + " · " + (data.status || sel.status || "unknown") : "–") + usualWall} />
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
        <div className="stat">
          <div className="statTop"><small>Cost</small><StatIcon kind="cost" /></div>
          {costBig ? (
            <div className="big usageBig"><span>{costBig.value}</span> <span className="unit">{costBig.unit}</span></div>
          ) : <div className="big"><span>{runCostText(sel)}</span></div>}
          <div className="detail">{costDetail}</div>
          {showUsageDetails ? <UsageInfo sel={sel} /> : null}
        </div>
      </div>
      <p className="note" style={{ display: notes.length ? "" : "none" }}>{notes.join(" ")}</p>
      {diag ? (
        <section className="panel" aria-label="Why was this slow" data-tour="story" style={{ marginTop: 12 }}>
          <div className="panelHead"><div><div className="pt">Why was this slow</div><div className="ps">Recorded data only · ranked causes · no model call, no estimates</div></div></div>
          {diag.verdict ? <div className="diagVerdict">{diag.verdict}</div> : null}
          <div className="diagBuckets">
            {diag.buckets.map((b) => (
              <div className="diagBucketRow" key={b.key}>
                <span className="diagBucketLabel">{b.label}</span>
                <span className="diagBucketTrack">
                  <span className={"diagBucketFill diagFill-" + b.key} style={{ width: (b.share_pct || 0) + "%" }}></span>
                </span>
                <span className="diagBucketValue">{b.ms == null ? "–" : fmtDur(b.ms) + " · " + b.share_pct + "%"}</span>
              </div>
            ))}
          </div>
          {diag.findings.length ? (
            <ol className="diagFindings">
              {diag.findings.map((f, i) => (
                <li key={i}>
                  {f.text}
                  {f.replay_offset_ms != null && data.selected ? (
                    <> <Link className="viewAll" to={"/replay/" + encodeURIComponent(data.selected) + "?t=" + Math.round(f.replay_offset_ms)}>Watch in Replay →</Link></>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="note">No recorded cause stands out. The slices above are the whole story the log tells.</p>
          )}
          {diag.partial_note ? <p className="note">{diag.partial_note}</p> : null}
          {detailLines.length ? (
            <>
              <div className="label" style={{ marginTop: 12 }}>What happened</div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
                {detailLines.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </>
          ) : null}
        </section>
      ) : whatLines.length ? (
        <section className="panel" aria-label="What happened" data-tour="story" style={{ marginTop: 12 }}>
          <div className="panelHead"><div><div className="pt">What happened</div><div className="ps">Recorded data only · no estimates</div></div></div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
            {whatLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </section>
      ) : null}
      <section className="panel" aria-label="Per-call breakdown" data-tour="per-call" style={{ marginTop: 12 }}>
        <div className="panelHead"><div><div className="pt">Per-call breakdown</div><div className="ps">Model time and input tokens per call, in order</div></div><span style={{ display: "flex", gap: 14, marginLeft: "auto", flex: "none" }}><button className="viewAll" type="button" onClick={() => onGoto("replay")}>Replay this run →</button><button className="viewAll" type="button" onClick={() => onGoto("xray")}>X-ray this run →</button></span></div>
        <PerCallChart events={events} provider={data.provider || sel.provider} />
        {(data.provider || sel.provider) !== "claude-code" ? <div className="legend"><span><span className="sw swModel"></span>model time</span>{retryTotal > 0 ? <span><span className="sw swStalled"></span>stalled</span> : null}<span>line = input tokens</span></div> : null}
      </section>
      <section className="panel scopePanel" aria-label="Shared filters" onKeyDown={onScopeBarKeyDown}>
        <div className="scopeBar">
          <div className="scopeBarText">
            <span className="label">Scope</span>
            <span className="scopeBarLabel">Shared with Runs</span>
          </div>
          <button ref={filterToggleRef} data-filter-toggle className="btn" type="button" aria-expanded={String(filtersOpen)} aria-controls="overviewSharedFilters" onClick={() => setFiltersOpen(!filtersOpen)}>
            {"Filters" + (sharedCount ? " · " + sharedCount : "") + (filtersOpen ? " ▴" : " ▾")}
          </button>
        </div>
        <div id="overviewSharedFilters" className="scopeFilters" hidden={!filtersOpen}>
          <FilterBar state={shared} providers={providers} models={models} onChange={updateFilters} />
        </div>
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
              {reply ? <span style={{ marginLeft: "auto", flex: "none" }}><CopyButton text={reply} label="Copy reply" /></span> : null}
            </div>
            {reply
              ? <div className={"reply" + (long && !replyExpanded ? " collapsed" : "")} dangerouslySetInnerHTML={{ __html: replyHtml(reply) }} />
              : <div className="reply"><p className="emptyReply">No reply recorded for this run.</p></div>}
            {long ? <button className="btn" style={{ marginTop: 8 }} onClick={() => setReplyExpanded(!replyExpanded)}>{replyExpanded ? "Show less" : "Show full reply"}</button> : null}
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
                        <div className="sub">{"Model " + fmtDur(r.model) + " · Overhead " + fmtDur(r.over) + (r.cost == null ? "" : " · Cost " + fmtCost(r.cost)) + " · " + r.ok + "/" + r.all + " ok"}</div>
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
