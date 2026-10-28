import React, { useMemo, useState } from "react";
import { RADAR_MIN_RUNS, fmt, fmtDur, localTime, radarMatrix, radarReport } from "../format.js";
import { download } from "../api.js";
import { Chip, CopyButton } from "../components/widgets.jsx";

function pctText(pct) {
  if (pct == null) return "–";
  const body = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return (pct > 0 ? "+" : "") + body + "%";
}

function changeText(delta) {
  if (!delta || delta.wall_ms.diff == null) return "–";
  const d = delta.wall_ms;
  const sign = d.diff > 0 ? "+" : d.diff < 0 ? "-" : "";
  return sign + fmtDur(Math.abs(d.diff)) + " (" + pctText(d.pct) + ")";
}

export default function Radar({ data }) {
  const matrix = useMemo(
    () => radarMatrix(data.sessions),
    [data.sessions]);
  const report = useMemo(
    () => radarReport(matrix, new Date().toISOString()),
    [matrix]);
  const recordedVersions = matrix.versions.filter((v) => v.recorded);
  const newest = recordedVersions[recordedVersions.length - 1];
  const suiteRuns = (data.sessions || [])
    .filter((s) => s.suite_id)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const lastSuite = suiteRuns[0];
  const withDelta = matrix.rows.filter((r) => r.delta).length;
  const hasSuiteRows = matrix.rows.some((r) => r.suite);
  const [suiteOnly, setSuiteOnly] = useState(null);
  const showSuiteOnly = hasSuiteRows && suiteOnly !== false;
  const shownRows = showSuiteOnly ? matrix.rows.filter((r) => r.suite) : matrix.rows;

  return (
    <section data-view-panel="radar">
      <div className="viewHead">
        <span className="hint">medians per prompt and harness version, from recorded runs</span>
      </div>
      <section className="panel" aria-label="Regression radar summary">
        <div className="panelHead">
          <div>
            <div className="pt">Regression radar</div>
            <div className="ps">Run the golden suite after a Muse update. This page lines the versions up.</div>
          </div>
          <span style={{ marginLeft: "auto", flex: "none", display: "flex", gap: 8 }}>
            <CopyButton text={report} label="Copy report" />
            <button
              className="btn"
              type="button"
              onClick={() => download("latency-report.md", radarReport(matrix, new Date().toISOString()), "text/markdown")}
            >Download report</button>
          </span>
        </div>
        <div className="statlets" style={{ marginTop: 0 }}>
          <div className="statlet"><span>Newest version recorded</span><strong>{newest ? newest.label : "–"}</strong></div>
          <div className="statlet"><span>Prompt groups</span><strong>{matrix.rows.length}</strong></div>
          <div className="statlet"><span>Groups with a version change</span><strong>{withDelta}</strong></div>
          <div className="statlet"><span>Suite last ran</span><strong>{lastSuite ? localTime(lastSuite.at) : "–"}</strong></div>
        </div>
        {lastSuite ? (
          <div id="runChips" style={{ marginTop: 10 }}>
            <Chip text={"suite " + lastSuite.suite_id} />
            <Chip text={"version " + (lastSuite.harness_version ?? "–")} />
          </div>
        ) : null}
        <p className="note">
          Fill a new column with <code className="inline">./run-muse --suite</code> in the terminal.
          It runs golden-prompts.json three times per prompt by default and stamps each run for this page.
          A change figure needs at least {RADAR_MIN_RUNS} completed runs on both versions.
          Below that the medians still show and the change stays a dash.
        </p>
      </section>
      <section className="panel" style={{ marginTop: 12 }} aria-label="Versions by prompt">
        <div className="panelHead">
          <div>
            <div className="pt">Medians by prompt and version</div>
            <div className="ps">Completed runs only. Cell shows median wall, then model time, input tokens and run count.</div>
          </div>
          {hasSuiteRows ? (
            <label className="replaySpeed" style={{ marginLeft: "auto", flex: "none" }}>
              <input
                type="checkbox"
                checked={showSuiteOnly}
                onChange={(e) => setSuiteOnly(e.target.checked)}
              />
              Golden suite only
            </label>
          ) : null}
        </div>
        {!shownRows.length ? (
          <div className="empty">No completed runs yet. Run ./run-muse --suite to start the radar.</div>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Prompt</th>
                  {matrix.versions.map((v) => (
                    <th key={v.key || "none"} className="num" title={v.label}>{v.label}</th>
                  ))}
                  <th className="num">Change in wall</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      {r.label}
                      {r.suite ? <span className="badgeFast" title="Golden suite prompt">suite</span> : null}
                      <div className="radarSub">{r.provider + "/" + r.model + " · " + r.context_mode + " context"}</div>
                    </td>
                    {matrix.versions.map((v) => {
                      const cell = r.cells[v.key];
                      if (!cell) return <td key={v.key || "none"} className="num">–</td>;
                      return (
                        <td key={v.key || "none"} className="num">
                          {fmtDur(cell.wall_ms)}
                          <div className="radarSub">
                            {"model " + fmtDur(cell.model_ms) + " · in " + fmt(cell.input_tokens == null ? null : Math.round(cell.input_tokens))
                              + " · " + cell.n + (cell.n === 1 ? " run" : " runs")}
                          </div>
                        </td>
                      );
                    })}
                    <td className="num">
                      {changeText(r.delta)}
                      {r.delta ? (
                        <div className="radarSub">{r.delta.from_version + " -> " + r.delta.to_version}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          Change compares the two newest recorded versions with enough runs on both sides.
          It is plain arithmetic on medians, in wall time. Bigger is not coloured better or worse.
          Runs with no recorded version sit in their own column and never feed a change figure.
          The report buttons generate the same numbers as markdown, ready to file.
          The Golden suite only toggle filters this table. The report always covers every group.
        </p>
      </section>
    </section>
  );
}
