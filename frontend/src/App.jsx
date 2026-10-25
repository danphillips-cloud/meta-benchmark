import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { dataSignature, localTime, shortText } from "./format.js";
import { copyText, deleteRun, download, fetchLogs } from "./api.js";
import { MoonIcon, NavIcon, SunIcon } from "./components/widgets.jsx";
import Overview from "./views/Overview.jsx";
import Runs from "./views/Runs.jsx";
import Compare from "./views/Compare.jsx";
import Timeline from "./views/Timeline.jsx";

const VIEWS = ["overview", "runs", "compare", "timeline"];
const EMPTY = { sessions: [], events: [], timeline: [], errors: [] };

function initialTheme() {
  try {
    return localStorage.getItem("muse-theme")
      || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (e) { return "light"; }
}

function App() {
  const [view, setViewState] = useState(() => {
    try { return VIEWS.includes(localStorage.getItem("muse-view")) ? localStorage.getItem("muse-view") : "overview"; }
    catch (e) { return "overview"; }
  });
  const [theme, setTheme] = useState(initialTheme);
  const [data, setData] = useState(EMPTY);
  const [selectedRun, setSelectedRun] = useState("");
  const [followDefault, setFollowDefault] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sourceText, setSourceText] = useState("Waiting for logs…");
  const [exportOpen, setExportOpen] = useState(false);
  const selectedRef = useRef("");
  const followRef = useRef(false);
  const sigRef = useRef("");
  const dataRef = useRef(EMPTY);
  const sessionSelectRef = useRef(null);

  const setView = useCallback((name) => {
    if (!VIEWS.includes(name)) name = "overview";
    setViewState(name);
    try { localStorage.setItem("muse-view", name); } catch (e) {}
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("muse-theme", theme); } catch (e) {}
  }, [theme]);

  const refresh = useCallback(async (runId) => {
    if (document.hidden) { setPaused(true); return; }
    try {
      const d = await fetchLogs(runId ?? selectedRef.current);
      dataRef.current = d;
      setPaused(false);
      setSourceText((d.sessions || []).length
        ? "Sessions: " + (d.sessions || []).length + " run(s) · " + (d.events || []).length + " call(s) · updated " + new Date().toLocaleTimeString()
        : "No runs yet. Run ./run-muse in your terminal and type a prompt.");
      // Pin the server's newest-completed default until the user picks
      // or clears a run (matches the vanilla page's select behaviour).
      if (!followRef.current && !selectedRef.current && d.selected) {
        selectedRef.current = d.selected;
        setSelectedRun(d.selected);
      }
      const sig = dataSignature(d);
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      setData(d);
    } catch (e) {
      setSourceText("Could not reach the local server: " + e.message);
    }
  }, []);

  useEffect(() => {
    refresh(selectedRef.current);
    const t = setInterval(() => refresh(), 2000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  const selectRun = useCallback((runId) => {
    if (!runId) return;
    followRef.current = false;
    setFollowDefault(false);
    selectedRef.current = runId;
    setSelectedRun(runId);
    sigRef.current = "";
    refresh(runId);
  }, [refresh]);

  const clearSelectedRun = useCallback(() => {
    followRef.current = true;
    setFollowDefault(true);
    selectedRef.current = "";
    setSelectedRun("");
    sigRef.current = "";
    refresh("");
  }, [refresh]);

  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = (e) => { if (!e.target.closest(".exportWrap")) setExportOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setExportOpen(false); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [exportOpen]);

  const handleDelete = useCallback(async () => {
    const target = selectedRef.current || dataRef.current.selected;
    if (!target) return;
    if (!confirm("Delete session " + target + "? This removes its local run data.")) return;
    const result = await deleteRun(target);
    if (!result.ok) { alert(result.reason || "Delete failed."); return; }
    selectedRef.current = "";
    setSelectedRun("");
    sigRef.current = "";
    refresh("");
  }, [refresh]);

  const selSession = (data.sessions || []).find((s) => s.run_id === data.selected) || {};
  const sessionValue = followDefault ? (data.selected || "") : (selectedRun || data.selected || "");
  const chipText = data.selected
    ? (selSession.at ? localTime(selSession.at).slice(11) + " · " : "") + shortText(data.prompt || "Selected run", 34)
    : "";

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

  return (
    <>
      <header className="topbar">
        <span className="pageTitle">meta-benchmark</span>
        {data.selected ? (
          <span className="runChip">
            <span className={"dot " + (data.status || selSession.status || "")}></span>
            <button className="chipText" type="button" title={(data.prompt || "Selected run") + " · " + ((data.provider || "?") + "/" + (data.model || "?"))}
              onClick={() => { setView("runs"); setTimeout(() => sessionSelectRef.current && sessionSelectRef.current.focus(), 0); }}>{chipText}</button>
            <button className="chipX" type="button" aria-label="Clear selected run" title="Clear selected run" onClick={clearSelectedRun}>×</button>
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
          {VIEWS.map((v) => (
            <button key={v} type="button" className={"navItem" + (view === v ? " active" : "")}
              aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}>
              <NavIcon view={v} />{v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
          <div className="sideFoot">
            <span className={"live" + (paused ? " paused" : "")}>{paused ? "● Paused (tab hidden)" : "● Live"}</span>
            <span>{sourceText}</span><br />Runs start in the terminal: <code className="inline">./run-muse</code>
          </div>
        </nav>
        <div className="content">
          <div hidden={view !== "overview"}><Overview data={data} onSelect={selectRun} onGoto={setView} /></div>
          <div hidden={view !== "runs"}><Runs data={data} sessionValue={sessionValue} onSessionChange={selectRun} onSelect={selectRun} onDelete={handleDelete} sessionSelectRef={sessionSelectRef} /></div>
          <div hidden={view !== "compare"}><Compare data={data} onSelect={selectRun} /></div>
          <div hidden={view !== "timeline"}><Timeline data={data} /></div>
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

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
