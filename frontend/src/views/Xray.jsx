import React, { useMemo } from "react";
import { fmt, perCallSeries, shortText, xrayFirstLanes, xrayHeadline, xrayLaneName, xrayLines, xraySeries } from "../format.js";

function segTitle(laneGroup) {
  const wires = laneGroup.groups
    .map((g) => (g.wire || "?") + " · " + fmt(g.bytes) + " bytes")
    .join("\n");
  return xrayLaneName(laneGroup.lane) + " (" + laneGroup.lane + ")\n" + wires;
}

export default function Xray({ data }) {
  const runId = data.selected || "";
  const series = useMemo(
    () => xraySeries(data.xray),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId]);
  const tokens = useMemo(
    () => perCallSeries(data.events, data.provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId]);
  const head = xrayHeadline(series);
  const lines = xrayLines(series);
  const maxTotal = Math.max(0, ...series.steps.map((s) => s.total_bytes || 0));
  const zeroNote = series.steps.reduce((a, s) => a + s.zero_groups, 0);

  const viewHead = (
    <div className="viewHead">
      <span className="hint">
        {data.selected
          ? shortText(data.prompt || data.selected, 60) + " · " + ((data.provider || "?") + "/" + (data.model || "?"))
          : ""}
      </span>
    </div>
  );

  if (!series.steps.length) {
    return (
      <section data-view-panel="xray">
        {viewHead}
        <section className="panel">
          <div className="panelHead"><div><div className="pt">Context X-ray</div><div className="ps">What Muse sent on each call, in recorded bytes</div></div></div>
          <p className="note">
            No input traces were recorded for this run, so there is nothing to X-ray.
            X-ray reads the per-call lane bytes in a Muse session log.
            Claude Code, raw API and echo runs do not record them, and neither does a run whose session log is gone.
          </p>
        </section>
      </section>
    );
  }

  const topFirst = xrayFirstLanes(series, 2);
  const hasRest = series.steps.some(
    (s) => s.total_bytes != null && s.total_bytes > s.lanes.reduce((a, l) => a + l.bytes, 0));
  return (
    <section data-view-panel="xray">
      {viewHead}
      <section className="panel" aria-label="X-ray headline">
        <div className="panelHead">
          <div>
            <div className="pt">Context X-ray</div>
            <div className="ps">Recorded bytes per request lane. Bytes are not tokens and are never converted.</div>
          </div>
        </div>
        <div className="replayClock">
          {fmt(head.total_bytes) + " bytes sent"}
          <span className="replayClockOf">{" on call 1"}</span>
        </div>
        <div className="replayState" role="status">
          {"Your prompt was " + fmt(head.user_bytes) + " of those bytes"
            + (head.user_pct != null ? " (" + head.user_pct + "%)." : ".")
            + " The rest is what Muse adds around it, lane by lane below."}
        </div>
        <div className="statlets">
          {topFirst.map((l) => (
            <div className="statlet" key={l.lane}><span>{xrayLaneName(l.lane) + ", call 1"}</span><strong>{fmt(l.bytes) + " bytes"}</strong></div>
          ))}
          <div className="statlet"><span>Your prompt, call 1</span><strong>{fmt(head.user_bytes) + " bytes"}</strong></div>
          <div className="statlet"><span>Calls traced</span><strong>{series.steps.length}</strong></div>
        </div>
        {lines.length ? (
          <ul style={{ margin: "12px 0 0", paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
            {lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        ) : null}
      </section>
      <section className="panel" style={{ marginTop: 12 }} aria-label="Lanes per call">
        <div className="panelHead">
          <div>
            <div className="pt">One bar per call</div>
            <div className="ps">Widths are true proportions of recorded bytes. Bar length also scales with the call total, so growth shows twice.</div>
          </div>
        </div>
        <div className="xrayBars">
          {series.steps.map((s) => {
            const denom = s.total_bytes || s.lanes.reduce((a, l) => a + l.bytes, 0);
            const widthPct = maxTotal ? Math.max(2, ((s.total_bytes || 0) / maxTotal) * 100) : 100;
            const shown = s.lanes.reduce((a, l) => a + l.bytes, 0);
            const rest = denom > shown ? denom - shown : 0;
            return (
              <div className="xrayRow" key={s.call}>
                <span className="xrayRowLabel">{"Call " + s.call}</span>
                <div className="xrayBar" style={{ width: widthPct + "%" }} role="img"
                  aria-label={"Call " + s.call + ": " + fmt(s.total_bytes) + " bytes across " + s.lanes.length + " lanes"}>
                  {s.lanes.map((l) => (
                    <div
                      key={l.lane}
                      className={"xraySeg xraySeg" + (series.laneOrder.indexOf(l.lane) % 6)}
                      style={{ width: denom ? (l.bytes / denom) * 100 + "%" : "0%" }}
                      title={segTitle(l)}
                    />
                  ))}
                  {rest > 0 ? (
                    <div
                      className="xraySeg xraySegRest"
                      style={{ width: denom ? (rest / denom) * 100 + "%" : "0%" }}
                      title={"Recorded in the total but not in the lane breakdown: " + fmt(rest) + " bytes"}
                    />
                  ) : null}
                </div>
                <span className="xrayRowTotal">{fmt(s.total_bytes) + " bytes" + (s.partial ? " · partial" : "")}</span>
              </div>
            );
          })}
        </div>
        <div className="legend">
          {series.laneOrder.map((lane, i) => (
            <span key={lane}><span className={"sw xraySeg" + (i % 6)}></span>{xrayLaneName(lane) + " (" + lane + ")"}</span>
          ))}
          {hasRest ? <span><span className="sw xraySegRest"></span>in the total, not broken down</span> : null}
        </div>
        {zeroNote ? (
          <p className="note">
            {fmt(zeroNote) + (zeroNote === 1 ? " lane group was" : " lane groups were")
              + " recorded at zero bytes across these calls and "
              + (zeroNote === 1 ? "is" : "are") + " left out of the bars."}
          </p>
        ) : null}
        <details>
          <summary>Exact lane bytes (table)</summary>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Lane</th>
                  {series.steps.map((s) => <th key={s.call} className="num">{"Call " + s.call}</th>)}
                </tr>
              </thead>
              <tbody>
                {series.laneOrder.map((lane) => (
                  <tr key={lane}>
                    <td>{xrayLaneName(lane) + " (" + lane + ")"}</td>
                    {series.steps.map((s) => (
                      <td key={s.call} className="num">{s.byLane[lane] == null ? "–" : fmt(s.byLane[lane])}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td>Total recorded bytes</td>
                  {series.steps.map((s) => <td key={s.call} className="num"><strong>{fmt(s.total_bytes)}</strong></td>)}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">All values are bytes, exactly as Muse recorded them. A dash means that lane was not recorded on that call.</p>
        </details>
      </section>
      {tokens.length ? (
        <section className="panel" style={{ marginTop: 12 }} aria-label="Tokens per call">
          <div className="panelHead">
            <div>
              <div className="pt">Tokens per call</div>
              <div className="ps">A different unit, kept apart from the bytes above. Input tokens are what the model billed as input.</div>
            </div>
          </div>
          <div className="tableWrap">
            <table>
              <thead><tr><th className="num">Call</th><th className="num">Input tokens</th><th className="num">Cached tokens</th><th className="num">Output tokens</th></tr></thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.call}>
                    <td className="num">{t.call}</td>
                    <td className="num">{fmt(t.input_tokens)}</td>
                    <td className="num">{fmt(t.cached_tokens)}</td>
                    <td className="num">{fmt(t.output_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}
