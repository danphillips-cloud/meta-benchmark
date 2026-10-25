import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter, Link, Navigate, Route, Routes, matchPath, useLocation, useNavigate, useSearchParams,
} from "react-router";
import { FILTER_KEYS, activeFilterChips, dataSignature, localTime, parseRunsQuery, shortText } from "./format.js";
import { deleteRun, download, fetchLogs } from "./api.js";
import { MoonIcon, NavIcon, SunIcon } from "./components/widgets.jsx";
import Overview from "./views/Overview.jsx";
import Runs from "./views/Runs.jsx";
import Compare from "./views/Compare.jsx";
import Timeline from "./views/Timeline.jsx";

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
  const sigRef = useRef("");
  const dataRef = useRef(EMPTY);
  const sessionSelectRef = useRef(null);

  const runDetail = matchPath("/runs/:id", location.pathname);
  const timelineDetail = matchPath("/timeline/:id", location.pathname);
  const compareDetail = matchPath("/compare/:setId", location.pathname);
  const routeRunId = (runDetail && runDetail.params.id) || (timelineDetail && timelineDetail.params.id) || "";
  const compareSetId = (compareDetail && compareDetail.params.setId) || "";
  const routeRunRef = useRef(routeRunId);
  routeRunRef.current = routeRunId;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("muse-theme", theme); } catch (e) {}
  }, [theme]);

  const refresh = useCallback(async (runId) => {
    if (document.hidden) { setPaused(true); return; }
    try {
      const d = await fetchLogs(runId ?? routeRunRef.current);
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
  const chipText = data.selected
    ? (selSession.at ? localTime(selSession.at).slice(11) + " · " : "") + shortText(data.prompt || "Selected run", 34)
    : "";
  const goto = (name) => {
    if (name === "runs") navigate("/runs" + qs);
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
  ];
  return (
    <>
      <header className="topbar">
        <span className="pageTitle">meta-benchmark</span>
        {data.selected ? (
          <span className="runChip">
            <span className={"dot " + (data.status || selSession.status || "")}></span>
            <button className="chipText" type="button" title={(data.prompt || "Selected run") + " · " + ((data.provider || "?") + "/" + (data.model || "?"))}
              onClick={() => navigate("/runs/" + encodeURIComponent(data.selected) + qs)}>{chipText}</button>
            <button className="chipX" type="button" aria-label="Clear selected run" title="Clear selected run" onClick={() => navigate("/" + qs)}>×</button>
          </span>
        ) : null}
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
          <div className="sideFoot">
            <span className={"live" + (paused ? " paused" : "")}>{paused ? "● Paused (tab hidden)" : "● Live"}</span>
            <span>{sourceText}</span><br />Runs start in the terminal: <code className="inline">./run-muse</code>
          </div>
        </nav>
        <div className="content">
          <Routes>
            <Route path="/" element={<Overview data={data} onSelect={selectRun} onGoto={goto} />} />
            <Route path="/runs" element={<Runs data={data} sessionValue={data.selected || ""} onSessionChange={selectRun} onSelect={selectRun} onDelete={handleDelete} sessionSelectRef={sessionSelectRef} />} />
            <Route path="/runs/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Overview data={data} onSelect={selectRun} onGoto={goto} />} />
            <Route path="/compare/:setId" element={compareNotFound ? <NotFound what="Compare set not found" /> : <Compare data={compareData} onSelect={selectRun} />} />
            <Route path="/compare" element={<Compare data={data} onSelect={selectRun} />} />
            <Route path="/timeline/:id" element={runNotFound ? <NotFound what="Run not found" /> : <Timeline data={data} />} />
            <Route path="/timeline" element={<Timeline data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <details className="helpBox">
            <summary>How to read this · commands · SDK docs</summary>
            <div className="panel">
              <ul>
                <li><strong>Wire</strong> is one model call, start to finish. <strong>Wall</strong> is the whole run; Wall minus Model time is local overhead.</li>
                <li>Labels say their scope: <em>run</em> totals cover every call; <em>last call</em> figures describe only the final call.</li>
                <li><strong>–</strong> means the harness did not report it. It is never estimated, and no chart is drawn for it.</li>
                <li>A compare run sends one prompt 2–3 ways. Its table uses medians over completed runs only; every round stays visible in the matrix.</li>
                <li>Timeline middle column is time to the next step, not step cost.</li>
              </ul>
              <p><code>./run-muse</code> prompt loop · <code>./run-muse "hi"</code> single run · <code>./run-muse --compare custom "hi"</code> one prompt, 3 ways · <code>python3 test_tool.py</code> tests</p>
              <p><a href="https://meta-models.github.io/muse-code-sdk/1.4/" target="_blank" rel="noopener">Muse SDK docs</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/notifications/session-tokenusage/" target="_blank" rel="noopener">session/tokenUsage</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/types/tokenusage/" target="_blank" rel="noopener">TokenUsage fields</a> · <a href="https://meta-models.github.io/muse-code-sdk/1.4/guides/msp-concepts/" target="_blank" rel="noopener">MSP concepts</a></p>
            </div>
          </details>
          <p className="foot">meta-benchmark is an unofficial local tool. It is not made by, or affiliated with, Meta. All run data stays on this machine.</p>
        </div>
      </main>
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
