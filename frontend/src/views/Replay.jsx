import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { fmt, fmtDur, legKey, localTime, parseReplayStart, replayAt, replayPair, replaySeries, shortText } from "../format.js";
import { fetchLogs } from "../api.js";

const SPEEDS = [1, 4, 10, 20, 60];

export default function Replay({ data }) {
  const runId = data.selected || "";
  const [searchParams] = useSearchParams();
  const startParamRef = useRef(null);
  startParamRef.current = searchParams.get("t");
  // Snapshot the series per run. The 2 second poll swaps `data`, and
  // playback must not reset or stretch because a poll landed.
  const series = useMemo(
    () => replaySeries(data.timeline, data.events),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId]);
  // Optional second side from ?vs=<runId>. Fetched once and
  // snapshotted, same discipline as the series above: the app poll
  // keeps refreshing only the primary payload and never disturbs
  // playback on either side.
  const vsId = searchParams.get("vs") || "";
  const [other, setOther] = useState(null);
  useEffect(() => {
    if (!vsId || vsId === runId) { setOther(null); return undefined; }
    let live = true;
    setOther({ state: "loading", data: null });
    fetchLogs(vsId).then((d) => {
      if (!live) return;
      const found = d.selected === vsId
        && (d.sessions || []).some((s) => s.run_id === vsId);
      setOther(found ? { state: "ready", data: d }
        : { state: "missing", data: null });
    }).catch(() => { if (live) setOther({ state: "error", data: null }); });
    return () => { live = false; };
  }, [vsId, runId]);
  const otherData = other && other.state === "ready" ? other.data : null;
  const otherSeries = useMemo(
    () => (otherData ? replaySeries(otherData.timeline, otherData.events) : null),
    [otherData]);
  const paired = Boolean(otherSeries);
  const pair = useMemo(
    () => (paired ? replayPair(series, otherSeries) : null),
    [paired, series, otherSeries]);
  const span = pair ? pair.span_ms : series.span_ms;
  const [offset, setOffset] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const offsetRef = useRef(0);
  const currentRowRef = useRef(null);

  const seek = useCallback((ms) => {
    const t = Math.max(0, Math.min(ms || 0, span));
    offsetRef.current = t;
    setOffset(t);
  }, [span]);

  useEffect(() => {
    setPlaying(false);
    // A ?t= start offset (doctor evidence links) applies once per run.
    seek(parseReplayStart(startParamRef.current, span));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!playing) return undefined;
    const startWall = performance.now();
    const startOffset = offsetRef.current;
    let raf = 0;
    const tick = (now) => {
      const next = startOffset + (now - startWall) * speed;
      if (next >= span) {
        seek(span);
        setPlaying(false);
        return;
      }
      offsetRef.current = next;
      setOffset(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, span, seek]);

  const at = replayAt(series, offset);
  const otherAt = paired ? replayAt(otherSeries, offset) : null;
  const offsets = pair ? pair.offsets : series.points.map((p) => p.offset_ms);
  const stepTo = useCallback((dir) => {
    setPlaying(false);
    if (dir > 0) {
      const nxt = offsets.find((o) => o > offsetRef.current + 0.5);
      seek(nxt == null ? span : nxt);
    } else {
      const prev = [...offsets].reverse().find((o) => o < offsetRef.current - 0.5);
      seek(prev == null ? 0 : prev);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsets, span, seek]);

  const togglePlay = useCallback(() => {
    if (!span) return;
    if (!playing && offsetRef.current >= span) seek(0);
    setPlaying((p) => !p);
  }, [playing, span, seek]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); stepTo(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(-1); }
      else if (e.key === "Home") { e.preventDefault(); setPlaying(false); seek(0); }
      else if (e.key === "End") { e.preventDefault(); setPlaying(false); seek(span); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, stepTo, seek, span]);

  const stepRows = useMemo(() => (paired
    ? [...series.points.map((p) => ({ p, side: 0 })),
      ...otherSeries.points.map((p) => ({ p, side: 1 }))]
      .sort((x, y) => x.p.offset_ms - y.p.offset_ms || x.side - y.side)
    : series.points.map((p) => ({ p, side: 0 }))), [paired, series, otherSeries]);
  let lastPassedRow = -1;
  stepRows.forEach((r, i) => { if (r.p.offset_ms <= offset) lastPassedRow = i; });
  useEffect(() => {
    if (playing && currentRowRef.current) {
      currentRowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [playing, lastPassedRow]);

  const onRulerClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !span) return;
    setPlaying(false);
    seek(((e.clientX - rect.left) / rect.width) * span);
  };

  const pct = (ms) => (span ? Math.max(0, Math.min(100, (ms / span) * 100)) : 0);
  const sideRuler = (s, segs, sideFlight, keyP) => (
    <>
      <div
        className="replayRuler"
        role="presentation"
        title="Click to move the playhead"
        onClick={onRulerClick}
      >
        {s.landings.map((l) => (l.model_start_ms != null ? (
          <div
            key={keyP + "bar" + l.call}
            className={"replayModelBar" + (l.offset_ms <= offset ? " done" : "") + (sideFlight && sideFlight.call === l.call ? " flying" : "")}
            style={{ left: pct(Math.max(0, l.model_start_ms)) + "%", width: Math.max(0.4, pct(l.offset_ms) - pct(Math.max(0, l.model_start_ms))) + "%" }}
            title={"Call " + l.call + " · model " + fmtDur(l.model_ms) + " · landed at " + fmtDur(l.offset_ms)}
          />
        ) : null))}
        {s.points.map((p, i) => (
          <div
            key={keyP + "tick" + i}
            className={"replayTick kind-" + p.kind + (p.offset_ms <= offset ? " done" : "")}
            style={{ left: pct(p.offset_ms) + "%" }}
            title={p.label + " at " + fmtDur(p.offset_ms)}
          />
        ))}
        <div className="replayPlayhead" style={{ left: pct(offset) + "%" }} />
      </div>
      {segs.length ? (
        <div className="replayToolLane" role="presentation" title="Click to move the playhead" onClick={onRulerClick}>
          {segs.map((iv, i) => (
            <div
              key={keyP + "seg" + i}
              className={"replayToolSeg kind-" + iv.kind + (iv.start_ms <= offset ? " done" : "")}
              style={{ left: pct(Math.max(0, iv.start_ms)) + "%", width: Math.max(0.2, pct(iv.start_ms + (iv.duration_ms || 0)) - pct(Math.max(0, iv.start_ms))) + "%" }}
              title={(iv.name || "unnamed tool") + " · " + fmtDur(iv.duration_ms)
                + " · started at " + fmtDur(iv.start_ms)
                + (iv.wait_ms ? " · includes " + fmtDur(iv.wait_ms) + " approval wait" : "")}
            />
          ))}
          <div className="replayPlayhead" style={{ left: pct(offset) + "%" }} />
        </div>
      ) : null}
    </>
  );
  const sideStatlets = (s, sideAt) => (
    <div className="statlets">
      <div className="statlet"><span>Calls landed by now</span><strong>{sideAt.calls_landed + " of " + s.landings.length}</strong></div>
      <div className="statlet"><span>Input tokens so far</span><strong>{fmt(sideAt.input_tokens)}</strong></div>
      <div className="statlet"><span>Output tokens so far</span><strong>{fmt(sideAt.output_tokens)}</strong></div>
      <div className="statlet"><span>Model time so far</span><strong>{fmtDur(sideAt.model_ms)}</strong></div>
      <div className="statlet"><span>Steps passed</span><strong>{sideAt.passed_count + " of " + s.points.length}</strong></div>
    </div>
  );
  // Tool and approval segments share the series clock. Snapshot per
  // run like the series, aligned through its recorded start time.
  const toolSegs = useMemo(() => {
    if (!series.start_at) return [];
    const t0 = Date.parse(series.start_at);
    return (((data.intervals || {}).intervals) || [])
      .map((iv) => ({ ...iv, start_ms: Date.parse(iv.start_at) - t0 }))
      .filter((iv) => Number.isFinite(iv.start_ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  const otherToolSegs = useMemo(() => {
    if (!paired || !otherSeries.start_at) return [];
    const t0 = Date.parse(otherSeries.start_at);
    return (((otherData.intervals || {}).intervals) || [])
      .map((iv) => ({ ...iv, start_ms: Date.parse(iv.start_at) - t0 }))
      .filter((iv) => Number.isFinite(iv.start_ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vsId, paired]);
  const unclosedNames = [
    ...(((data.intervals || {}).unclosed_tools) || []),
    ...(((data.intervals || {}).unclosed_approvals) || []),
  ];
  const otherUnclosedNames = otherData ? [
    ...(((otherData.intervals || {}).unclosed_tools) || []),
    ...(((otherData.intervals || {}).unclosed_approvals) || []),
  ] : [];
  const flight = at.in_flight_call
    ? series.landings.find((l) => l.call === at.in_flight_call) : null;
  const otherFlight = otherAt && otherAt.in_flight_call
    ? otherSeries.landings.find((l) => l.call === otherAt.in_flight_call) : null;
  const rowOf = (id) => (data.sessions || []).find((s) => s.run_id === id) || null;
  const legA = rowOf(runId) ? legKey(rowOf(runId)) : ((data.provider || "?") + "/" + (data.model || "?"));
  const legB = rowOf(vsId) ? legKey(rowOf(vsId)) : vsId;
  const gapNote = !pair ? null
    : pair.gap_ms == null
      ? "Start times were not both recorded. Each side starts at its own first recorded step."
      : Math.abs(pair.gap_ms) < 1000
        ? "Both runs started together. The clock is shared real time."
        : Math.abs(pair.gap_ms) < 3600000
          ? "The runs started " + fmtDur(Math.abs(pair.gap_ms)) + " apart. Each side starts at its own first recorded step."
          : "First run started " + localTime(series.start_at) + ". Second run started " + localTime(otherSeries.start_at) + ". Each side starts at its own first recorded step.";
  const wallDiffers = data.wall_ms != null && series.span_ms > 0
    && Math.abs(data.wall_ms - series.span_ms) > 1000;
  const stateLine = (sideAt, sideFlight) => (sideFlight
    ? "Model call " + sideFlight.call + " in flight. It landed at " + fmtDur(sideFlight.offset_ms) + "."
    : sideAt.current
      ? "Last recorded step: " + sideAt.current.label + "."
      : "Before the first recorded step.")
    + (sideFlight && sideFlight.retries > 0 && sideFlight.stalled_ms != null
      ? " Recorded for this call: stalled " + fmtDur(sideFlight.stalled_ms) + " before retry."
      : "")
    + (sideAt.next ? " Next: " + sideAt.next.label + " at " + fmtDur(sideAt.next.offset_ms) + "." : " End of the recorded steps.");

  const head = (
    <div className="viewHead">
      <span className="hint">
        {vsId
          ? legA + " · " + legB
          : data.selected
            ? shortText(data.prompt || data.selected, 60) + " · " + ((data.provider || "?") + "/" + (data.model || "?"))
            : ""}
      </span>
    </div>
  );

  if (!series.points.length && !(paired && otherSeries.points.length)) {
    return (
      <section data-view-panel="replay">
        {head}
        <section className="panel">
          <div className="panelHead"><div><div className="pt">Replay</div><div className="ps">Play a recorded run back, step by step</div></div></div>
          <p className="note">No timed steps were recorded for this run, so there is nothing to replay.</p>
          {series.untimed.length ? (
            <p className="note">
              {series.untimed.length + (series.untimed.length === 1 ? " step has" : " steps have") + " no recorded time: "}
              {series.untimed.map((p) => p.label).join(", ") + "."}
            </p>
          ) : null}
        </section>
      </section>
    );
  }

  return (
    <section data-view-panel="replay">
      {head}
      <section className="panel" aria-label="Replay controls">
        <div className="panelHead">
          <div>
            <div className="pt">Replay</div>
            <div className="ps">Recorded steps only. Speed changes playback rate. Gaps stay as long as they really were.</div>
          </div>
        </div>
        <div className="replayClock" aria-live="off">
          {fmtDur(Math.round(offset))}
          <span className="replayClockOf">{" of " + fmtDur(span)}</span>
        </div>
        <div className="replayState" role="status">
          {paired ? legA + ": " + stateLine(at, flight) : stateLine(at, flight)}
        </div>
        {paired ? (
          <div className="replayState" role="status">
            {legB + ": " + stateLine(otherAt, otherFlight)}
          </div>
        ) : null}
        {gapNote ? <p className="note">{gapNote}</p> : null}
        {vsId && other && other.state === "loading" ? (
          <p className="note">Loading the second run.</p>
        ) : null}
        {vsId && other && other.state === "missing" ? (
          <p className="note">{"Second run " + vsId + " was not found. Showing this run alone."}</p>
        ) : null}
        {vsId && other && other.state === "error" ? (
          <p className="note">The second run could not be loaded. Showing this run alone.</p>
        ) : null}
        {paired && !otherSeries.points.length ? (
          <p className="note">The second run has no timed steps, so its side stays empty.</p>
        ) : null}
        {paired && !series.points.length ? (
          <p className="note">This run has no timed steps, so its side stays empty.</p>
        ) : null}
        {paired ? <div className="replaySideLabel">{legA}</div> : null}
        {sideRuler(series, toolSegs, flight, "a")}
        {paired ? <div className="replaySideLabel">{legB}</div> : null}
        {paired ? sideRuler(otherSeries, otherToolSegs, otherFlight, "b") : null}
        <div className="legend">
          <span><span className="sw swModel"></span>model call. Bars end when the call landed. Bar starts are derived from recorded model time</span>
          <span>tick = one recorded step</span>
          {toolSegs.length || otherToolSegs.length ? <span><span className="sw replayToolSw"></span>tool segment, named in its tooltip, widths true</span> : null}
          {[...toolSegs, ...otherToolSegs].some((iv) => iv.kind === "approval") ? <span><span className="sw swStalled"></span>approval wait</span> : null}
        </div>
        {unclosedNames.length ? (
          <p className="note">
            {[...new Set(unclosedNames)].join(", ") + " started but never recorded a finish and "
              + (unclosedNames.length === 1 ? "is" : "are") + " not drawn on the tool lane."}
          </p>
        ) : null}
        {otherUnclosedNames.length ? (
          <p className="note">
            {legB + ": " + [...new Set(otherUnclosedNames)].join(", ") + " started but never recorded a finish and "
              + (otherUnclosedNames.length === 1 ? "is" : "are") + " not drawn on the tool lane."}
          </p>
        ) : null}
        <div className="replayTransport">
          <button className="btn replayPlay" type="button" onClick={togglePlay} disabled={!span} aria-label={playing ? "Pause replay" : "Play replay"}>
            {playing ? "Pause" : offset >= span && span ? "Play again" : "Play"}
          </button>
          <button className="btn" type="button" onClick={() => stepTo(-1)} aria-label="Previous recorded step">Prev step</button>
          <button className="btn" type="button" onClick={() => stepTo(1)} aria-label="Next recorded step">Next step</button>
          <button className="btn" type="button" onClick={() => { setPlaying(false); seek(0); }}>Restart</button>
          <label className="replaySpeed">
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
              {SPEEDS.map((s) => <option key={s} value={s}>{s + "x"}</option>)}
            </select>
          </label>
          <span className="replayKeys">Space plays. Arrow keys step between recorded steps.</span>
        </div>
        <input
          className="replayScrub"
          type="range"
          min={0}
          max={span || 0}
          step={10}
          value={Math.round(offset)}
          disabled={!span}
          aria-label="Replay position in milliseconds from the first recorded step"
          onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }}
        />
        {paired ? <div className="replaySideLabel">{legA}</div> : null}
        {sideStatlets(series, at)}
        {paired ? <div className="replaySideLabel">{legB}</div> : null}
        {paired ? sideStatlets(otherSeries, otherAt) : null}
        {data.status === "running" ? (
          <p className="note">This run is still going. Replay shows the steps recorded when this run was picked. Pick it again later for the full recording.</p>
        ) : null}
        {otherData && otherData.status === "running" ? (
          <p className="note">The second run is still going. Its side shows the steps recorded when it was loaded.</p>
        ) : null}
        {!series.landings.length ? (
          <p className="note">This run has no timed model call rows, so token and model counters stay as dashes. Steps still replay at their recorded times.</p>
        ) : null}
        {wallDiffers ? (
          <p className="note">{"Stored wall time is " + fmtDur(data.wall_ms) + ". The timed steps span " + fmtDur(series.span_ms) + " from first to last recorded step. The ruler uses the steps."}</p>
        ) : null}
        {series.untimed.length ? (
          <p className="note">
            {series.untimed.length + (series.untimed.length === 1 ? " step has" : " steps have") + " no recorded time and "
              + (series.untimed.length === 1 ? "is" : "are") + " not on the ruler: "}
            {series.untimed.map((p) => p.label).join(", ") + "."}
          </p>
        ) : null}
        {paired && otherSeries.untimed.length ? (
          <p className="note">
            {legB + ": " + otherSeries.untimed.length + (otherSeries.untimed.length === 1 ? " step has" : " steps have") + " no recorded time and "
              + (otherSeries.untimed.length === 1 ? "is" : "are") + " not on the ruler: "}
            {otherSeries.untimed.map((p) => p.label).join(", ") + "."}
          </p>
        ) : null}
      </section>
      <section className="panel" style={{ marginTop: 12 }} aria-label="Recorded steps">
        <div className="panelHead">
          <div>
            <div className="pt">Recorded steps</div>
            <div className="ps">Oldest first. Click a step to move the playhead to its recorded time.</div>
          </div>
        </div>
        <div className="replaySteps">
          {stepRows.map(({ p, side }, i) => {
            const isCurrent = side === 0 ? p === at.current
              : Boolean(otherAt && p === otherAt.current);
            return (
              <button
                key={side + "-" + i}
                type="button"
                ref={i === lastPassedRow ? currentRowRef : undefined}
                className={"replayStep" + (p.offset_ms <= offset ? " done" : "") + (isCurrent ? " current" : "")}
                onClick={() => { setPlaying(false); seek(p.offset_ms); }}
                aria-label={"Move playhead to " + p.label + " at " + fmtDur(p.offset_ms)}
              >
                <span className="replayStepAt">{fmtDur(p.offset_ms)}</span>
                <span className={"replayStepDot kind-" + p.kind}></span>
                {paired ? <span className="replayStepLeg">{side === 0 ? legA : legB}</span> : null}
                <span className="replayStepLabel">{p.label}</span>
                <span className="replayStepMeta">
                  {(p.kind === "model" ? "model " + fmtDur(p.wire_ms) + " · " : "") + localTime(p.at)}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </section>
  );
}
