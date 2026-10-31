import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  brushCentered, brushPan, brushResize, chartData, clampBrush, fmt, fmtSec,
  fmtTickSec, labelIndexes, linearTicks, localTime, overviewScope, perCallSeries,
  shortText, showBrush,
} from "../format.js";

// Hand-rolled SVG charts. Same heights, colours, tooltips and
// interactions the Recharts version had, drawn with plain SVG so
// the bundle carries no chart library. Geometry helpers live in
// format.js where the tests are.

const TICK_STYLE = { fontSize: 11, fill: "var(--muted)" };

function useWidth() {
  // Callback ref: the wrapper can mount after an empty-state render,
  // so the observer must attach whenever the node appears.
  const [node, setNode] = useState(null);
  const ref = React.useCallback((el) => setNode(el), []);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return undefined;
    const ro = new ResizeObserver(() => setWidth(node.clientWidth));
    ro.observe(node);
    setWidth(node.clientWidth);
    return () => ro.disconnect();
  }, [node]);
  return [ref, width, node];
}

// A rect with only the top corners rounded, for the top stack segment.
function topRounded(x, y, w, h, r = 3) {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return "M" + x + "," + (y + h)
    + " L" + x + "," + (y + rr)
    + " Q" + x + "," + y + " " + (x + rr) + "," + y
    + " L" + (x + w - rr) + "," + y
    + " Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + rr)
    + " L" + (x + w) + "," + (y + h) + " Z";
}

function YGrid({ ticks, y, left, plotW, format }) {
  return (
    <g>
      {ticks.map((t) => (
        <line key={"g" + t} x1={left} x2={left + plotW} y1={y(t)} y2={y(t)}
          stroke="var(--line)" strokeDasharray="3 3" />
      ))}
      {ticks.map((t) => (
        <text key={"t" + t} x={left - 8} y={y(t) + 4} textAnchor="end" style={TICK_STYLE}>
          {format(t)}
        </text>
      ))}
    </g>
  );
}

// Tooltip that follows the cursor inside the chart box. Measures
// itself after render, then flips or clamps so it never spills out.
function ChartTooltip({ tip, width, height, children }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    if (tip && ref.current) {
      setBox({ w: ref.current.offsetWidth, h: ref.current.offsetHeight, k: tip.k });
    }
  }, [tip]);
  if (!tip) return null;
  const measured = box && box.k === tip.k;
  const w = measured ? box.w : 0;
  const h = measured ? box.h : 0;
  let left = tip.x + 14;
  if (left + w > width) left = tip.x - 14 - w;
  left = Math.max(0, left);
  const top = Math.min(Math.max(0, tip.y - 12), Math.max(0, height - h));
  return (
    <div ref={ref} className="svgChartTip"
      style={{ left, top, visibility: measured ? "visible" : "hidden" }}>
      {children}
    </div>
  );
}

function ChartTip({ d }) {
  return (
    <div className="chartTip">
      <div className="chartTipTitle">{localTime(d.at) + " · " + d.provider + "/" + d.model}</div>
      <div>{"Wall: " + (d.wall_ms == null ? "not reported" : fmtSec(d.wall_ms))}</div>
      <div>{"Model: " + fmtSec(d.model_ms)}</div>
      <div>{"Overhead: " + fmtSec(d.overhead_ms)}</div>
      <div>{"Status: " + d.status}</div>
      {d.prompt ? <div className="chartTipPrompt">{shortText(d.prompt, 72)}</div> : null}
      {d.greyed ? <div>Did not complete</div> : null}
    </div>
  );
}

function PerCallTip({ d }) {
  return (
    <div className="chartTip">
      <div className="chartTipTitle">{"Call " + d.call}</div>
      <div>{"Model: " + (d.model_ms == null ? "not reported" : fmtSec(d.model_ms))}</div>
      {d.retries > 0 && d.stalled_ms != null ? <div>{"Stalled: " + fmtSec(d.stalled_ms) + " (" + d.retries + (d.retries === 1 ? " retry" : " retries") + ")"}</div> : null}
      <div>{"Input: " + fmt(d.input_tokens) + " tokens"}</div>
      <div>{"Cached: " + fmt(d.cached_tokens) + " tokens"}</div>
    </div>
  );
}

// Overview strip with a draggable window, shown past 12 runs.
// Drag a traveller to resize, drag the window to pan, click the
// strip outside the window to recentre there.
function BrushStrip({ data, range, onChange, x, y, w, totalMax }) {
  const h = 24;
  const count = data.length;
  const dragRef = useRef(null);
  const stripRef = useRef(null);
  const [a, b] = range;
  const idxFloat = (e) => {
    const r = stripRef.current.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * count;
  };
  const down = (mode) => (e) => {
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    const f = idxFloat(e);
    if (mode === "jump") {
      const nr = brushCentered(range, f, count);
      onChange(nr);
      dragRef.current = { mode: "pan", off: f - nr[0] };
    } else if (mode === "pan") {
      dragRef.current = { mode, off: f - a };
    } else {
      dragRef.current = { mode };
    }
  };
  const move = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const f = idxFloat(e);
    if (drag.mode === "left" || drag.mode === "right") {
      onChange(brushResize(range, drag.mode, Math.floor(f), count));
    } else {
      onChange(brushPan(range, drag.off, f, count));
    }
  };
  const up = () => { dragRef.current = null; };
  const band = w / count;
  const winX = x + a * band;
  const winW = (b - a + 1) * band;
  const clampGrip = (gx) => Math.min(Math.max(gx, x), x + w - 10);
  const grip = (gx, mode) => (
    <g onPointerDown={down(mode)} style={{ cursor: "ew-resize", touchAction: "none" }}>
      <rect x={gx} y={y} width={10} height={h} fill="var(--accent)" />
      <line x1={gx + 3.5} x2={gx + 3.5} y1={y + 7} y2={y + h - 7} stroke="var(--onaccent)" strokeWidth={1.4} />
      <line x1={gx + 6.5} x2={gx + 6.5} y1={y + 7} y2={y + h - 7} stroke="var(--onaccent)" strokeWidth={1.4} />
    </g>
  );
  return (
    <g onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ touchAction: "none" }}>
      <rect ref={stripRef} x={x} y={y} width={w} height={h}
        fill="var(--pre)" stroke="var(--line)" onPointerDown={down("jump")} />
      {data.map((d, i) => {
        const bh = totalMax > 0 ? ((d.model_s + d.overhead_s) / totalMax) * (h - 4) : 0;
        return bh > 0 ? (
          <rect key={d.run_id + i} x={x + i * band + band * 0.15} y={y + h - 2 - bh}
            width={Math.max(1, band * 0.7)} height={bh}
            fill="var(--barover)" opacity={0.55} pointerEvents="none" />
        ) : null;
      })}
      <rect x={winX} y={y} width={winW} height={h} fill="var(--selected)"
        fillOpacity={0.75} stroke="var(--accent)"
        onPointerDown={down("pan")} style={{ cursor: "grab", touchAction: "none" }} />
      {grip(clampGrip(winX), "left")}
      {grip(clampGrip(winX + winW - 10), "right")}
    </g>
  );
}

export function RunsBarChart({ runs, selected, onSelect }) {
  const [wrapRef, width, wrapNode] = useWidth();
  const [win, setWin] = useState(null);
  const [tip, setTip] = useState(null);
  const data = chartData(runs, selected);
  const sig = data.map((d) => d.run_id).join("|");
  const sigRef = useRef(sig);
  useEffect(() => {
    const prev = sigRef.current;
    if (prev !== sig) {
      sigRef.current = sig;
      // New runs only ever append at the end of the oldest-first
      // chart order. Keep the window then. Any other change means
      // the run set itself changed, so reset to the full range.
      if (!(prev === "" || sig.startsWith(prev + "|"))) setWin(null);
    }
  }, [sig]);
  if (!data.length) return <div className="empty" style={{ minHeight: 120 }}>No runs in scope.</div>;

  const brush = showBrush(data.length);
  const height = brush ? 264 : 232;
  const range = brush ? clampBrush(win || [0, data.length - 1], data.length) : [0, data.length - 1];
  const view = data.slice(range[0], range[1] + 1);
  const left = 52, top = 8;
  const plotW = Math.max(0, width - left - 8);
  const plotH = height - top - 22 - (brush ? 32 : 0);
  const maxView = view.reduce((m, d) => Math.max(m, d.model_s + d.overhead_s), 0);
  const maxAll = data.reduce((m, d) => Math.max(m, d.model_s + d.overhead_s), 0);
  const { top: yTop, ticks, step: yStep } = linearTicks(maxView);
  const y = (v) => top + plotH - (v / yTop) * plotH;
  const base = y(0);
  const band = view.length ? plotW / view.length : plotW;
  const barW = Math.max(1, band * 0.7);
  const labels = labelIndexes(view.length, plotW);
  const segProps = (d) => ({
    fillOpacity: d.greyed ? 0.45 : 1,
    stroke: d.isSelected ? "var(--ink)" : "transparent",
    strokeWidth: d.isSelected ? 2 : 0,
    pointerEvents: "none",
  });

  return (
    <div ref={wrapRef} className="svgChartWrap" style={{ width: "100%", height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img"
          aria-label={"Stacked bar chart of model and overhead seconds for " + view.length + " runs"}
          onMouseLeave={() => setTip(null)}>
          <YGrid ticks={ticks} y={y} left={left} plotW={plotW} format={(v) => fmtTickSec(v, yStep)} />
          <line x1={left} x2={left + plotW} y1={base} y2={base} stroke="var(--line)" />
          {view.map((d, i) => {
            const bx = left + i * band + (band - barW) / 2;
            const mH = base - y(d.model_s);
            const oH = y(d.model_s) - y(d.model_s + d.overhead_s);
            return (
              <g key={d.run_id}>
                {tip && tip.k === d.run_id ? (
                  <rect x={left + i * band} y={top} width={band} height={plotH} fill="var(--chip)" opacity={0.5} />
                ) : null}
                {mH > 0 ? <rect x={bx} y={y(d.model_s)} width={barW} height={mH} fill="var(--barmodel)" {...segProps(d)} /> : null}
                {oH > 0 ? <path d={topRounded(bx, y(d.model_s + d.overhead_s), barW, oH)} fill="var(--barover)" {...segProps(d)} /> : null}
              </g>
            );
          })}
          {view.map((d, i) => (
            <rect key={"hit" + d.run_id} x={left + i * band} y={top} width={band} height={plotH}
              fill="transparent" style={{ cursor: "pointer" }}
              onMouseMove={(e) => {
                const r = wrapNode.getBoundingClientRect();
                setTip({ k: d.run_id, d, x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onClick={() => { if (d.run_id && onSelect) onSelect(d.run_id); }} />
          ))}
          {labels.map((i) => (
            <text key={"x" + i} x={left + i * band + band / 2} y={base + 16}
              textAnchor="middle" style={TICK_STYLE}>{view[i].time}</text>
          ))}
          {brush ? (
            <BrushStrip data={data} range={range} onChange={setWin}
              x={left} y={height - 24} w={plotW} totalMax={maxAll} />
          ) : null}
        </svg>
      ) : null}
      <ChartTooltip tip={tip} width={width} height={height}>
        {tip ? <ChartTip d={tip.d} /> : null}
      </ChartTooltip>
    </div>
  );
}

export function RecentRunsChart({ data, onSelect, scope }) {
  const sc = scope || overviewScope(data, null);
  return <RunsBarChart runs={sc.runs} selected={data.selected} onSelect={onSelect} />;
}

export function PerCallChart({ events, provider }) {
  const [wrapRef, width, wrapNode] = useWidth();
  const [tip, setTip] = useState(null);
  if (provider === "claude-code") {
    return <p className="note">Claude Code doesn't report per-call time</p>;
  }
  const series = perCallSeries(events, provider);
  if (!series.length) return <div className="empty" style={{ minHeight: 80 }}>No calls yet.</div>;
  const data = series.map((d) => ({
    ...d,
    label: String(d.call),
    active_s: d.model_ms == null ? 0 : Math.max(0, d.model_ms - (d.stalled_ms || 0)) / 1000,
    stalled_s: (d.stalled_ms || 0) / 1000,
  }));

  const height = 220;
  const left = 52, right = 60, top = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - top - 36;
  const maxTime = data.reduce((m, d) => Math.max(m, d.active_s + d.stalled_s), 0);
  const maxTok = data.reduce((m, d) => Math.max(m, d.input_tokens || 0), 0);
  const time = linearTicks(maxTime);
  const tok = linearTicks(maxTok);
  const yT = (v) => top + plotH - (v / time.top) * plotH;
  const yK = (v) => top + plotH - (v / tok.top) * plotH;
  const base = yT(0);
  const band = data.length ? plotW / data.length : plotW;
  const barW = Math.max(1, band * 0.7);
  const labels = labelIndexes(data.length, plotW, 24);
  // Straight segments between recorded points. A null token count
  // breaks the line rather than bridging over missing data.
  const linePath = data.reduce((acc, d, i) => {
    if (d.input_tokens == null) return { path: acc.path, pen: false };
    const px = left + i * band + band / 2;
    const py = yK(d.input_tokens);
    return { path: acc.path + (acc.pen ? " L" : " M") + px + "," + py, pen: true };
  }, { path: "", pen: false }).path;

  return (
    <div ref={wrapRef} className="svgChartWrap" style={{ width: "100%", height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img"
          aria-label={"Per-call model time bars and input token line for " + data.length + " calls"}
          onMouseLeave={() => setTip(null)}>
          <YGrid ticks={time.ticks} y={yT} left={left} plotW={plotW} format={(v) => fmtTickSec(v, time.step)} />
          {tok.ticks.map((t) => (
            <text key={"k" + t} x={left + plotW + 8} y={yK(t) + 4} textAnchor="start" style={TICK_STYLE}>
              {fmt(t)}
            </text>
          ))}
          <line x1={left} x2={left + plotW} y1={base} y2={base} stroke="var(--line)" />
          {data.map((d, i) => {
            const bx = left + i * band + (band - barW) / 2;
            const aH = base - yT(d.active_s);
            const sH = yT(d.active_s) - yT(d.active_s + d.stalled_s);
            return (
              <g key={d.call} pointerEvents="none">
                {tip && tip.k === d.call ? (
                  <rect x={left + i * band} y={top} width={band} height={plotH} fill="var(--chip)" opacity={0.5} />
                ) : null}
                {aH > 0 ? <rect x={bx} y={yT(d.active_s)} width={barW} height={aH} fill="var(--barmodel)" /> : null}
                {sH > 0 ? <path d={topRounded(bx, yT(d.active_s + d.stalled_s), barW, sH)} fill="var(--barstalled)" /> : null}
              </g>
            );
          })}
          {linePath ? (
            <path d={linePath} fill="none" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />
          ) : null}
          {data.map((d, i) => (d.input_tokens == null ? null : (
            <circle key={"dot" + d.call} cx={left + i * band + band / 2} cy={yK(d.input_tokens)} r={3}
              fill="var(--card)" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />
          )))}
          {data.map((d, i) => (
            <rect key={"hit" + d.call} x={left + i * band} y={top} width={band} height={plotH}
              fill="transparent"
              onMouseMove={(e) => {
                const r = wrapNode.getBoundingClientRect();
                setTip({ k: d.call, d, x: e.clientX - r.left, y: e.clientY - r.top });
              }} />
          ))}
          {labels.map((i) => (
            <text key={"x" + i} x={left + i * band + band / 2} y={base + 16}
              textAnchor="middle" style={TICK_STYLE}>{data[i].label}</text>
          ))}
          <text x={left + plotW / 2} y={height - 2} textAnchor="middle" style={TICK_STYLE}>call</text>
        </svg>
      ) : null}
      <ChartTooltip tip={tip} width={width} height={height}>
        {tip ? <PerCallTip d={tip.d} /> : null}
      </ChartTooltip>
    </div>
  );
}
