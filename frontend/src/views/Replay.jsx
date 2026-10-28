import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { fmt, fmtDur, localTime, parseReplayStart, replayAt, replaySeries, shortText } from "../format.js";

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
  const span = series.span_ms;
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
  const offsets = series.points.map((p) => p.offset_ms);
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
  }, [series, span, seek]);

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

  const currentIndex = at.current ? series.points.indexOf(at.current) : -1;
  useEffect(() => {
    if (playing && currentRowRef.current) {
      currentRowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [playing, currentIndex]);

  const onRulerClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !span) return;
    setPlaying(false);
    seek(((e.clientX - rect.left) / rect.width) * span);
  };

  const pct = (ms) => (span ? Math.max(0, Math.min(100, (ms / span) * 100)) : 0);
  const flight = at.in_flight_call
    ? series.landings.find((l) => l.call === at.in_flight_call) : null;
  const wallDiffers = data.wall_ms != null && span > 0
    && Math.abs(data.wall_ms - span) > 1000;

  const head = (
    <div className="viewHead">
      <span className="hint">
        {data.selected
          ? shortText(data.prompt || data.selected, 60) + " · " + ((data.provider || "?") + "/" + (data.model || "?"))
          : ""}
      </span>
    </div>
  );

  if (!series.points.length) {
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
          {flight
            ? "Model call " + flight.call + " in flight. It landed at " + fmtDur(flight.offset_ms) + "."
            : at.current
              ? "Last recorded step: " + at.current.label + "."
              : "Before the first recorded step."}
          {flight && flight.retries > 0 && flight.stalled_ms != null
            ? " Recorded for this call: stalled " + fmtDur(flight.stalled_ms) + " before retry."
            : ""}
          {at.next ? " Next: " + at.next.label + " at " + fmtDur(at.next.offset_ms) + "." : " End of the recorded steps."}
        </div>
        <div
          className="replayRuler"
          role="presentation"
          title="Click to move the playhead"
          onClick={onRulerClick}
        >
          {series.landings.map((l) => (l.model_start_ms != null ? (
            <div
              key={"bar" + l.call}
              className={"replayModelBar" + (l.offset_ms <= offset ? " done" : "") + (flight && flight.call === l.call ? " flying" : "")}
              style={{ left: pct(Math.max(0, l.model_start_ms)) + "%", width: Math.max(0.4, pct(l.offset_ms) - pct(Math.max(0, l.model_start_ms))) + "%" }}
              title={"Call " + l.call + " · model " + fmtDur(l.model_ms) + " · landed at " + fmtDur(l.offset_ms)}
            />
          ) : null))}
          {series.points.map((p, i) => (
            <div
              key={"tick" + i}
              className={"replayTick kind-" + p.kind + (p.offset_ms <= offset ? " done" : "")}
              style={{ left: pct(p.offset_ms) + "%" }}
              title={p.label + " at " + fmtDur(p.offset_ms)}
            />
          ))}
          <div className="replayPlayhead" style={{ left: pct(offset) + "%" }} />
        </div>
        <div className="legend">
          <span><span className="sw swModel"></span>model call. Bars end when the call landed. Bar starts are derived from recorded model time</span>
          <span>tick = one recorded step</span>
        </div>
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
        <div className="statlets">
          <div className="statlet"><span>Calls landed by now</span><strong>{at.calls_landed + " of " + series.landings.length}</strong></div>
          <div className="statlet"><span>Input tokens so far</span><strong>{fmt(at.input_tokens)}</strong></div>
          <div className="statlet"><span>Output tokens so far</span><strong>{fmt(at.output_tokens)}</strong></div>
          <div className="statlet"><span>Model time so far</span><strong>{fmtDur(at.model_ms)}</strong></div>
          <div className="statlet"><span>Steps passed</span><strong>{at.passed_count + " of " + series.points.length}</strong></div>
        </div>
        {data.status === "running" ? (
          <p className="note">This run is still going. Replay shows the steps recorded when this run was picked. Pick it again later for the full recording.</p>
        ) : null}
        {!series.landings.length ? (
          <p className="note">This run has no timed model call rows, so token and model counters stay as dashes. Steps still replay at their recorded times.</p>
        ) : null}
        {wallDiffers ? (
          <p className="note">{"Stored wall time is " + fmtDur(data.wall_ms) + ". The timed steps span " + fmtDur(span) + " from first to last recorded step. The ruler uses the steps."}</p>
        ) : null}
        {series.untimed.length ? (
          <p className="note">
            {series.untimed.length + (series.untimed.length === 1 ? " step has" : " steps have") + " no recorded time and "
              + (series.untimed.length === 1 ? "is" : "are") + " not on the ruler: "}
            {series.untimed.map((p) => p.label).join(", ") + "."}
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
          {series.points.map((p, i) => {
            const isCurrent = i === currentIndex;
            return (
              <button
                key={i}
                type="button"
                ref={isCurrent ? currentRowRef : undefined}
                className={"replayStep" + (p.offset_ms <= offset ? " done" : "") + (isCurrent ? " current" : "")}
                onClick={() => { setPlaying(false); seek(p.offset_ms); }}
                aria-label={"Move playhead to " + p.label + " at " + fmtDur(p.offset_ms)}
              >
                <span className="replayStepAt">{fmtDur(p.offset_ms)}</span>
                <span className={"replayStepDot kind-" + p.kind}></span>
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
