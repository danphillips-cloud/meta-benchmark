import React from "react";
import { fmt, fmtDur, fmtDurExact, localTime, scopedRuns, shortText, timeHM } from "../format.js";

// Plain SVG charts (Recharts arrives in a later step). Heights are
// strictly proportional to reported values; null draws a flat tick.

export function RecentRunsChart({ data, onSelect }) {
  const scope = scopedRuns(data);
  const chrono = [...scope.runs].reverse();
  const W = 720, H = 196, padT = 18, padB = 36;
  if (!chrono.length) {
    return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stacked bar chart of recent runs, split into model time and overhead" />;
  }
  const completedWalls = chrono.filter((s) => s.status === "completed" && s.wall_ms != null).map((s) => s.wall_ms);
  const allWalls = chrono.map((s) => s.wall_ms).filter((v) => v != null);
  const trueMax = allWalls.length ? Math.max(...allWalls) : 0;
  const max = completedWalls.length ? Math.max(...completedWalls) : trueMax;
  const slot = W / chrono.length;
  const bw = Math.max(3, Math.min(26, slot * 0.66));
  const plotH = H - padT - padB;
  const rotate = chrono.length > 8;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stacked bar chart of recent runs, split into model time and overhead">
      <text x={0} y={11} className="chartText">{max ? (max < trueMax ? "scale max " : "max ") + fmtDur(max) : ""}</text>
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} className="axis" />
      {chrono.map((s, i) => {
        const cappedEarly = s.wall_ms != null && max && s.wall_ms > max;
        const greyed = s.status !== "completed" && s.status !== "running";
        const title = localTime(s.at) + " · " + (s.provider || "?") + "/" + (s.model || "?")
          + " · wall " + (s.wall_ms == null ? "not reported" : fmtDurExact(s.wall_ms))
          + " · model " + fmtDurExact(s.model_ms) + " · overhead " + fmtDurExact(s.overhead_ms)
          + " · " + (s.status || "unknown") + " · " + shortText(s.prompt || "", 60)
          + (greyed ? " · greyed: did not complete" : "")
          + (cappedEarly ? " · cut off: longer than the slowest completed run in scope (scale max " + fmtDurExact(max) + "); exact wall " + fmtDurExact(s.wall_ms) : "");
        const x = slot * i + (slot - bw) / 2;
        const base = H - padB;
        let bars;
        if (s.wall_ms == null || s.wall_ms <= 0 || !max) {
          bars = <rect x={x.toFixed(1)} y={H - padB - 2} width={bw.toFixed(1)} height={2} className="barBad" />;
        } else {
          const capped = s.wall_ms > max;
          const totalH = Math.max(3, plotH * Math.min(s.wall_ms, max) / max);
          const modelFrac = s.model_ms != null ? Math.min(1, Math.max(0, s.model_ms / s.wall_ms)) : 0;
          const modelH = totalH * modelFrac;
          const overH = totalH - modelH;
          bars = (<>
            {overH > 0 ? <rect x={x.toFixed(1)} y={(base - totalH).toFixed(1)} width={bw.toFixed(1)} height={overH.toFixed(1)} rx={2} className={"segOverRect" + (s.run_id === data.selected ? " barSel" : "")} /> : null}
            {modelH > 0 ? <rect x={x.toFixed(1)} y={(base - modelH).toFixed(1)} width={bw.toFixed(1)} height={modelH.toFixed(1)} rx={2} className={(s.status === "running" ? "bar barRun" : "bar") + (s.run_id === data.selected ? " barSel" : "")} /> : null}
            {capped ? <rect x={x.toFixed(1)} y={(base - totalH).toFixed(1)} width={bw.toFixed(1)} height={3} className="capMark" /> : null}
          </>);
        }
        const cx = slot * i + slot / 2;
        return (
          <React.Fragment key={s.run_id + "-" + i}>
            <g className={"pickable" + (greyed ? " runBad" : "")} tabIndex={0} role="button" aria-label={title}
              onClick={() => onSelect(s.run_id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.run_id); } }}>
              <title>{title}</title>
              {bars}
            </g>
            {rotate
              ? <text x={cx.toFixed(1)} y={H - padB + 12} textAnchor="end" className="chartText" transform={`rotate(-40 ${cx.toFixed(1)} ${H - padB + 12})`}>{timeHM(s.at)}</text>
              : <text x={cx.toFixed(1)} y={H - 6} textAnchor="middle" className="chartText">{timeHM(s.at)}</text>}
          </React.Fragment>
        );
      })}
    </svg>
  );
}

export function CallChart({ events }) {
  const chrono = [...(events || [])].reverse();
  const vals = chrono.map((e) => e["wire_ms"]);
  const W = 560, H = 150, padT = 18, padB = 18;
  const nums = vals.filter((v) => v != null);
  const max = nums.length ? Math.max(...nums) : 0;
  const slot = W / Math.max(1, chrono.length);
  const bw = Math.max(2, Math.min(42, slot * 0.68));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart of wire time per model call">
      <text x={0} y={11} className="chartText">{max ? "max " + fmtDur(max) : ""}</text>
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} className="axis" />
      {chrono.map((e, i) => {
        const v = vals[i];
        const hgt = (v != null && max > 0) ? Math.max(2, (H - padT - padB) * Math.min(v, max) / max) : 2;
        const x = slot * i + (slot - bw) / 2;
        const title = "Call " + (i + 1) + " · wire " + (v == null ? "not reported" : fmtDurExact(v))
          + " · in " + fmt(e["gen_ai.usage.input_tokens"]) + " · out " + fmt(e["gen_ai.usage.output_tokens"]);
        return (
          <React.Fragment key={i}>
            <rect x={x.toFixed(1)} y={(H - padB - hgt).toFixed(1)} width={bw.toFixed(1)} height={hgt.toFixed(1)} rx={2}
              className={v == null ? "barBad" : (v === max ? "bar barMax" : "bar")}>
              <title>{title}</title>
            </rect>
            {v != null && v > max ? <rect x={x.toFixed(1)} y={(H - padB - hgt).toFixed(1)} width={bw.toFixed(1)} height={3} className="capMark" /> : null}
          </React.Fragment>
        );
      })}
      <text x={0} y={H - 5} className="chartText">call 1</text>
      <text x={W} y={H - 5} textAnchor="end" className="chartText">{"call " + chrono.length}</text>
    </svg>
  );
}
