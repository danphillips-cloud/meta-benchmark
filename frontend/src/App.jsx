import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter, Link, Navigate, Route, Routes, matchPath, useLocation, useNavigate, useSearchParams,
} from "react-router";
import { FILTER_KEYS, activeFilterChips, dataSignature, latestOnly, markWalkthroughSeen, parseRunsQuery, walkthroughSeen, walkthroughSteps } from "./format.js";
import { deleteRun, download, fetchLogs } from "./api.js";
import { MoonIcon, NavIcon, SunIcon } from "./components/widgets.jsx";
import Walkthrough from "./components/walkthrough.jsx";
import Overview from "./views/Overview.jsx";
import Runs from "./views/Runs.jsx";
import Compare from "./views/Compare.jsx";
import Timeline from "./views/Timeline.jsx";
import Replay from "./views/Replay.jsx";
import Xray from "./views/Xray.jsx";
import Radar from "./views/Radar.jsx";

const EMPTY = { sessions: [], events: [], timeline: [], errors: [] };

function initialTheme() {
  try {
    return localStorage.getItem("muse-theme")
      || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (e) { return "light"; }
}

function NotFound({ what }) {
  return (
    <section className="panel" aria-label={what}>
      <div className="pt" style={{ fontSize: 15, fontWeight: 650 }}>{what}</div>
      <p className="note">That link does not match a recorded run. It may have been deleted.</p>
      <p><Link to="/runs">View all runs →</Link></p>
    </section>
  );
}

function activeView(pathname) {
  if (pathname === "/") return "overview";
  if (pathname === "/runs") return "runs";
  if (pathname.startsWith("/runs/")) return "overview";
  if (pathname.startsWith("/compare")) return "compare";
  if (pathname.startsWith("/timeline")) return "timeline";
  if (pathname.startsWith("/replay")) return "replay";
  if (pathname.startsWith("/xray")) return "xray";
  if (pathname.startsWith("/radar")) return "radar";
  return "overview";
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const filterChips = activeFilterChips(parseRunsQuery(searchParams));
  const removeChip = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key === "date") { next.delete("from"); next.delete("to"); }
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    FILTER_KEYS.forEach((k) => next.delete(k));
    setSearchParams(next, { replace: true });
  };
  const qs = location.search || "";
  const [theme, setTheme] = useState(initialTheme);
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sourceText, setSourceText] = useState("Waiting for logs…");
  const [exportOpen, setExportOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourSteps, setTourSteps] = useState(null);
  const tourButtonRef = useRef(null);
  const tourReturnRef = useRef(null);
  const tourAutoRef = useRef(false);
  const tourStorage = () => {
    try { return window.localStorage; } catch (e) { return null; }
  };
  const openTour = useCallback(() => {
    if (tourOpen) return;
    tourReturnRef.current = location.pathname + location.search;
    // Snapshot the steps at open time. Live data can change
    // the selection mid-tour, and step 7 must stay on the run
    // the tour started with.
    setTourSteps(walkthroughSteps({ selectedId: data.selected || "" }));
    setTourOpen(true);
  }, [tourOpen, location.pathname, location.search, data.selected]);
  const closeTour = useCallback(() => {
    markWalkthroughSeen(tourStorage());
    setTourOpen(false);
    setTourSteps(null);
    const back = tourReturnRef.current;
    tourReturnRef.current = null;
    const onTourRoute = (tourSteps || []).some(
      (s) => s.route && s.route === location.pathname);
    if (back && onTourRoute
        && back !== location.pathname + location.search) {
      navigate(back, { replace: true });
    }
    if (tourButtonRef.current) tourButtonRef.current.focus();
  }, [tourSteps, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (loaded && !tourAutoRef.current) {
      tourAutoRef.current = true;
      if (!walkthroughSeen(tourStorage())) openTour();
    }
  }, [loaded, openTour]);
  const sigRef = useRef("");
  const dataRef = useRef(EMPTY);
  const requestGuardRef = useRef(null);
  if (!requestGuardRef.current) requestGuardRef.current = latestOnly();

  const runDetail = matchPath("/runs/:id", location.pathname);
  const timelineDetail = matchPath("/timeline/:id", location.pathname);
  const replayDetail = matchPath("/replay/:id", location.pathname);
  const xrayDetail = matchPath("/xray/:id", location.pathname);
  const compareDetail = matchPath("/compare/:setId", location.pathname);
  const routeRunId = (runDetail && runDetail.params.id) || (timelineDetail && timelineDetail.params.id) || (replayDetail && replayDetail.params.id) || (xrayDetail && xrayDetail.params.id) || "";
  const compareSetId = (compareDetail && compareDetail.params.setId) || "";
  const routeRunRef = useRef(routeRunId);
  routeRunRef.current = routeRunId;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("muse-theme", theme); } catch (e) {}
  }, [theme]);

  const refresh = useCallback(async (runId) => {
    if (document.hidden) { setPaused(true); return; }
    // Only the latest issued request may apply its result. A late
    // response for an earlier run must never paint under a newer
    // run's URL. The token is taken after the hidden check, so a
    // skipped poll does not invalidate a fetch already in flight.
    const guard = requestGuardRef.current;
    const token = guard.take();
    try {
      const d = await fetchLogs(runId ?? routeRunRef.current);
      if (!guard.isCurrent(token)) return;
      dataRef.current = d;
      setLoaded(true);
      setPaused(false);
      setSourceText((d.sessions || []).length
        ? "Sessions: " + (d.sessions || []).length + " run(s) · " + (d.events || []).length + " call(s) · updated " + new Date().toLocaleTimeString()
        : "No runs yet. Run ./run-muse in your terminal and type a prompt.");
      const sig = dataSignature(d);
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      setData(d);
    } catch (e) {
      if (!guard.isCurrent(token)) return;
      setSourceText("Could not reach the local server: " + e.message);
    }
  }, []);

  useEffect(() => { sigRef.current = ""; refresh(routeRunId); }, [routeRunId, refresh]);

  useEffect(() => {
    const t = setInterval(() => refresh(), 2000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  // The selected run lives in the URL. Clicking a run anywhere goes to
  // its Overview URL; browser back/forward then move between runs.
  const selectRun = useCallback((runId) => {
    if (!runId) return;
    navigate("/runs/" + encodeURIComponent(runId) + (window.location.search || ""));
  }, [navigate]);

  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = (e) => { if (!e.target.closest(".exportWrap")) setExportOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setExportOpen(false); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [exportOpen]);

  const handleDelete = useCallback(async () => {
    const target = routeRunRef.current || dataRef.current.selected;
    if (!target) return;
    if (!confirm("Delete session " + target + "? This removes its local run data.")) return;
    const result = await deleteRun(target);
    if (!result.ok) { alert(result.reason || "Delete failed."); return; }
    sigRef.current = "";
    navigate("/runs");
    refresh("");
  }, [navigate, refresh]);

  const sessions = data.sessions || [];
  const runNotFound = loaded && Boolean(routeRunId)
    && !sessions.some((s) => s.run_id === routeRunId);
  const compareRep = compareSetId
    ? sessions.find((s) => s.comparison_id === compareSetId) : null;
  const compareNotFound = loaded && Boolean(compareSetId) && !compareRep;
  const compareData = compareRep ? { ...data, selected: compareRep.run_id } : data;
  const selSession = sessions.find((s) => s.run_id === data.selected) || {};
  const view = activeView(location.pathname);
  const goto = (name) => {
    if (name === "runs") navigate("/runs" + qs);
    else if (name === "replay") navigate((data.selected ? "/replay/" + encodeURIComponent(data.selected) : "/replay") + qs);
    else if (name === "xray") navigate((data.selected ? "/xray/" + encodeURIComponent(data.selected) : "/xray") + qs);
    else if (name === "compare") navigate((selSession.comparison_id ? "/compare/" + encodeURIComponent(selSession.comparison_id) : "/compare") + qs);
    else navigate("/" + qs);
  };

  const exportCsv = () => {
    const lastData = dataRef.current;
    const rows = [["prompt", "model", "wire_ms", "input_tokens", "output_tokens"]];
    (lastData.events || []).forEach((e) => rows.push([
      e.prompt, e.model, e["wire_ms"],
      e["gen_ai.usage.input_tokens"], e["gen_ai.usage.output_tokens"]]));
    const csv = rows.map((r) => r.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
    download("meta-benchmark-" + (lastData.selected || "session") + ".csv", csv, "text/csv");
  };
  const exportJson = () => {
    const lastData = dataRef.current;
    download("meta-benchmark-" + (lastData.selected || "session") + ".json",
      JSON.stringify(lastData, null, 2), "application/json");
  };

  const NAV = [
    ["overview", "Overview", "/"],
    ["runs", "Runs", "/runs"],
    ["compare", "Compare", selSession.comparison_id ? "/compare/" + encodeURIComponent(selSession.comparison_id) : "/compare"],
    ["timeline", "Timeline", data.selected ? "/timeline/" + encodeURIComponent(data.selected) : "/"],
    ["replay", "Replay", data.selected ? "/replay/" + encodeURIComponent(data.selected) : "/replay"],
    ["xray", "X-ray", data.selected ? "/xray/" + encodeURIComponent(data.selected) : "/xray"],
    ["radar", "Radar", "/radar"],
  ];
  return (
    <>
      <header className="topbar">
        <span className="pageTitle">meta-benchmark</span>
        {filterChips.length ? (
          <span className="filterChips" aria-label="Active filters">
            <span className="filterChipsLabel">Filters</span>
            {filterChips.map((c) => (
              <span key={c.key} className="pill model">{c.label}
                <button type="button" className="chipRemove" aria-label={"Remove filter " + c.label} onClick={() => removeChip(c.key)}>×</button>
              </span>
            ))}
            <button type="button" className="btn" style={{ padding: "3px 9px" }} onClick={clearFilters}>Clear all</button>
          </span>
        ) : null}
        <div className="topbarRight">
          <div className="exportWrap">
            <button className="btn" type="button" aria-haspopup="menu" aria-expanded={String(exportOpen)}
              onClick={(e) => { e.stopPropagation(); setExportOpen(!exportOpen); }}>Export ▾</button>
            <div className="exportMenu" role="menu" hidden={!exportOpen} onClick={() => setExportOpen(false)}>
              <button className="btn" type="button" role="menuitem" onClick={exportCsv}>Export CSV</button>
              <button className="btn" type="button" role="menuitem" onClick={exportJson}>Export JSON</button>
            </div>
          </div>
          <button id="themeToggle" aria-label="Toggle night mode" title={theme === "dark" ? "Switch to day mode" : "Switch to night mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</button>
        </div>
      </header>
      <main className="shell">
        <nav className="sidebar" aria-label="Views">
          {NAV.map(([key, label, to]) => (
            <Link key={key} to={to + qs} className={"navItem" + (view === key ? " active" : "")}
              aria-current={view === key ? "page" : undefined}>
              <NavIcon view={key} />{label}
            </Link>
          ))}
          <button ref={tourButtonRef} type="button" className="navItem" onClick={openTour}>Getting started</button>
          <div className="sideFoot" data-tour="terminal">
            <span className={"live" + (paused ? " paused" : "")}>{paused ? "● Paused (tab hidden)" : "● Live"}</span>
            <span>{sourceText}</span><br />Runs start in the terminal: <code className="inline">./run-muse</code>
          </div>
        </nav>
        <div className="content">
          <Routes>
            <Route path="/" element={<Overview data={data} onSelect={selectRun} onGoto={goto} />} />
            <Route path="/runs" element={<Runs data={data} sessionValue={data.selected || ""} onSessionChange={selectRun} onSelect={selectRun} onDelete={handleDelete} />} />
            <Route path="/runs/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Overview data={data} onSelect={selectRun} onGoto={goto} />} />
            <Route path="/compare/:setId" element={compareNotFound ? <NotFound what="Compare set not found" /> : <Compare data={compareData} onSelect={selectRun} />} />
            <Route path="/compare" element={<Compare data={data} onSelect={selectRun} />} />
            <Route path="/timeline/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Timeline data={data} />} />
            <Route path="/timeline" element={<Timeline data={data} />} />
            <Route path="/replay/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Replay data={data} />} />
            <Route path="/replay" element={<Replay data={data} />} />
            <Route path="/xray/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Xray data={data} />} />
            <Route path="/xray" element={<Xray data={data} />} />
            <Route path="/radar" element={<Radar data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <details className="helpBox">
            <summary>How to read this · commands · SDK docs</summary>
            <div className="panel">
              <ul>
                <li><strong>Wall</strong> is the whole run. It splits into <strong>Model</strong> (the model thinking), <strong>Tools</strong> (commands Muse ran), <strong>Approval wait</strong>, and <strong>Muse</strong> (everything else Muse did). All four come from timestamps in Muse's own log.</li>
                <li><strong>Model time</strong> is one model call, start to finish. Labels say their scope. <em>Run</em> totals cover every call. <em>Last call</em> figures describe only the final call.</li>
                <li><strong>–</strong> means the harness did not report it. It is never estimated, and no chart is drawn for it. Claude Code doesn't report per-call time, so its per-call columns are blank and Model uses its API time.</li>
                <li>A compare run sends one prompt 2–3 ways. Its table uses medians over completed runs only. Every round stays visible in the matrix.</li>
                <li>Timeline middle column is time to the next step, not step cost.</li>
                <li><strong>Replay</strong> plays the selected run back at its recorded step times. Counters count only calls that had landed by the playhead. Model bar starts are derived from recorded model time. Steps with no recorded time stay off the ruler. The thin lane under the ruler holds named tool and approval segments at true width, so short tools are slivers.</li>
                <li><strong>X-ray</strong> shows what Muse sent on each model call, lane by lane, in recorded bytes. Bytes are not tokens and are never converted. The token table under the bars is a separate unit. A partial note means the log omitted some lane groups for that call.</li>
                <li><strong>Radar</strong> lines medians up by prompt and harness version. Run <code>./run-muse --suite</code> after a Muse update to fill a new column. A change figure needs at least two completed runs on both versions and is plain arithmetic on medians. The report buttons generate those same numbers as markdown.</li>
                <li><strong>Why was this slow</strong> ranks one run from recorded data only. Buckets show where the wall went. Findings name what stands out inside them, like a stall inside model time. Thresholds only choose what surfaces. Every number is recorded, and Watch links open Replay at that moment.</li>
              </ul>
              <p><code>./run-muse</code> prompt loop · <code>./run-muse "hi"</code> single run · <code>./run-muse --compare meta "hi"</code> one prompt, two Meta models · <code>python3 test_tool.py</code> tests</p>
              <p><a href="https://meta-models.github.io/muse-code-sdk/1.4/" target="_blank" rel="noopener">Muse SDK docs</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/notifications/session-tokenusage/" target="_blank" rel="noopener">session/tokenUsage</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/types/tokenusage/" target="_blank" rel="noopener">TokenUsage fields</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/guides/msp-concepts/" target="_blank" rel="noopener">MSP concepts</a></p>
            </div>
          </details>
          <p className="foot">meta-benchmark is an unofficial local tool. It is not made by, or affiliated with, Meta. All run data stays on this machine.</p>
        </div>
      </main>
      {tourOpen && tourSteps ? (
        <Walkthrough steps={tourSteps}
          onNavigate={(route) => { if (route !== location.pathname) navigate(route + location.search, { replace: true }); }}
          onClose={closeTour} />
      ) : null}
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
