import React, { useLayoutEffect, useRef, useState } from "react";
import {
  brushCentered, brushKey, brushPan, brushResizeAt, brushWindow, chartData,
  chartKeyIndex, clampBrush, fmt, fmtSec, fmtTickSec, gripPositions, labelIndexes, linearTicks,
  localTime, overviewScope, perCallSeries, shortText, showBrush, tipPosition,
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
  // Layout effect, so the first measure lands before first paint
  // instead of after a blank one.
  useLayoutEffect(() => {
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

// Hover and keyboard share one active bar. State changes only when
// the active bar changes. Pointer moves inside a bar place the open
// tooltip straight on its DOM node, so they never re-render the chart.
// The aria-live summary follows keyboard focus only (announcedKey),
// never hover. Leaving the bar area clears a pointer-set bar and
// leaves a keyboard-set one alone.
function useChartTip(wrapNode, width, height) {
  const [activeKey, setActiveKey] = useState(null);
  const [announcedKey, setAnnouncedKey] = useState(null);
  const sourceRef = useRef(null);
  const tipRef = useRef(null);
  const pos = useRef({ x: 0, y: 0 });
  const place = React.useCallback(() => {
    const el = tipRef.current;
    if (!el) return;
    const p = tipPosition(pos.current.x, pos.current.y, el.offsetWidth, el.offsetHeight, width, height);
    el.style.left = p.left + "px";
    el.style.top = p.top + "px";
    el.style.visibility = "visible";
  }, [width, height]);
  // A new tip only appears with a new active bar, and the callback
  // covers size changes, so these dependencies re-place it whenever
  // its content or the chart box can have changed.
  useLayoutEffect(place, [place, activeKey]);
  const hover = (e, k) => {
    const r = wrapNode.getBoundingClientRect();
    pos.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    sourceRef.current = "pointer";
    if (k !== activeKey) setActiveKey(k);
    else place();
  };
  const focusAt = (k, x, y) => {
    pos.current = { x, y };
    sourceRef.current = "keyboard";
    setActiveKey(k);
    setAnnouncedKey(k);
  };
  const clearPointer = () => {
    if (sourceRef.current === "pointer") setActiveKey(null);
  };
  const clearAll = () => {
    sourceRef.current = null;
    setActiveKey(null);
    setAnnouncedKey(null);
  };
  return { activeKey, announcedKey, tipRef, hover, focusAt, clearPointer, clearAll };
}

// Tooltip box. Starts hidden and useChartTip positions and shows it
// once it has measured its own size.
function ChartTooltip({ tipRef, children }) {
  if (!children) return null;
  return (
    <div ref={tipRef} className="svgChartTip" style={{ visibility: "hidden" }}>
      {children}
    </div>
  );
}

// Shared frame for both bar charts: wrapper, svg, tooltip and the
// aria-live summary. Plot children sit in one group, and leaving
// that group (for labels, the token axis or the brush) clears a
// pointer-set bar. The live summary renders the announced text,
// which only keyboard focus changes. Per-chart extras such as the
// brush, axis labels and the token line go in beforePlot/afterPlot.
function BarChartShell({ wrapRef, width, height, ariaLabel, onKeyDown, onBlur,
  clearPointer, tipRef, tip, announced, beforePlot, afterPlot, children }) {
  return (
    <div ref={wrapRef} className="svgChartWrap" style={{ width: "100%", height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="group" tabIndex={0}
          aria-label={ariaLabel} onKeyDown={onKeyDown} onBlur={onBlur}>
          {beforePlot}
          <g onMouseLeave={clearPointer}>{children}</g>
          {afterPlot}
        </svg>
      ) : null}
      <ChartTooltip tipRef={tipRef}>{tip}</ChartTooltip>
      <span className="srOnly" aria-live="polite">{announced}</span>
    </div>
  );
}

// One stacked bar: optional highlight band, a plain lower segment
// and a top-rounded upper segment. Zero-height segments draw nothing.
function StackedBar({ bandX, band, top, plotH, active, bx, barW,
  lowY, lowH, lowFill, upY, upH, upFill, segProps, noPointer }) {
  return (
    <g pointerEvents={noPointer ? "none" : undefined}>
      {active ? (
        <rect x={bandX} y={top} width={band} height={plotH} fill="var(--chip)" opacity={0.5} />
      ) : null}
      {lowH > 0 ? <rect x={bx} y={lowY} width={barW} height={lowH} fill={lowFill} {...segProps} /> : null}
      {upH > 0 ? <path d={topRounded(bx, upY, barW, upH)} fill={upFill} {...segProps} /> : null}
    </g>
  );
}

// Invisible full-height bands that take hover (and click, when a
// chart offers selection). They tile the whole plot, so moving
// between bars never leaves the plot group above.
function HitBands({ items, left, top, band, plotH, keyOf, hover, onPick }) {
  return (
    <g>
      {items.map((d, i) => (
        <rect key={"hit" + keyOf(d)} x={left + i * band} y={top} width={band} height={plotH}
          fill="transparent" style={onPick ? { cursor: "pointer" } : undefined}
          onMouseMove={(e) => hover(e, keyOf(d))}
          onClick={onPick ? () => onPick(d) : undefined} />
      ))}
    </g>
  );
}

// Shared chart keys: Escape clears, arrows step the announced bar.
// guardTarget keeps keys on the chart itself when focusable
// children (the brush sliders) handle their own. onEnter, when
// given, opens the active bar.
function makeChartKeyHandler({ activeIdx, count, focusAtIndex, clearAll, guardTarget, onEnter }) {
  return (e) => {
    if (guardTarget && e.target !== e.currentTarget) return;
    if (onEnter && (e.key === "Enter" || e.key === " ") && activeIdx >= 0) {
      e.preventDefault();
      onEnter();
      return;
    }
    if (e.key === "Escape") { clearAll(); return; }
    const n = chartKeyIndex(e.key, activeIdx, count);
    if (n == null) return;
    e.preventDefault();
    focusAtIndex(n);
  };
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

// One-line versions of the tooltips for screen readers.
const runSummary = (d) => localTime(d.at) + ", " + d.provider + "/" + d.model
  + ". Wall " + (d.wall_ms == null ? "not reported" : fmtSec(d.wall_ms))
  + ". Status " + d.status + ".";
const callSummary = (d) => "Call " + d.call + ". Model "
  + (d.model_ms == null ? "not reported" : fmtSec(d.model_ms))
  + ". Input " + fmt(d.input_tokens) + " tokens.";

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
      // Resize keeps a grab offset like pan does, so the edge
      // follows the pointer instead of jumping on the first move.
      const edgeFloat = mode === "left" ? a : b + 1;
      dragRef.current = { mode, off: f - edgeFloat };
    }
  };
  const move = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const f = idxFloat(e);
    if (drag.mode === "left" || drag.mode === "right") {
      onChange(brushResizeAt(range, drag.mode, drag.off, f, count));
    } else {
      onChange(brushPan(range, drag.off, f, count));
    }
  };
  const up = () => { dragRef.current = null; };
  const band = w / count;
  const winX = x + a * band;
  const winW = (b - a + 1) * band;
  const [leftGripX, rightGripX] = gripPositions(winX, winW, x, w);
  // Mini-bars depend on the data and strip geometry only, never on
  // the window, so a drag re-render does not rebuild every rect.
  const miniBars = React.useMemo(() => data.map((d, i) => {
    const bh = totalMax > 0 ? ((d.model_s + d.overhead_s) / totalMax) * (h - 4) : 0;
    return bh > 0 ? (
      <rect key={d.run_id} x={x + i * band + band * 0.15} y={y + h - 2 - bh}
        width={Math.max(1, band * 0.7)} height={bh}
        fill="var(--barover)" opacity={0.55} pointerEvents="none" />
    ) : null;
  }), [data, totalMax, x, y, band]);
  const grip = (gx, mode) => (
    <g onPointerDown={down(mode)} style={{ cursor: "ew-resize", touchAction: "none" }}
      role="slider" tabIndex={0}
      aria-label={mode === "left" ? "Window start" : "Window end"}
      aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={mode === "left" ? a : b}
      aria-valuetext={"Run " + ((mode === "left" ? a : b) + 1) + " of " + count + ", "
        + data[mode === "left" ? a : b].time}
      onKeyDown={(e) => {
        const nr = brushKey(range, mode, e.key, count);
        if (nr) { e.preventDefault(); onChange(nr); }
      }}>
      <rect x={gx} y={y} width={10} height={h} fill="var(--accent)" />
      <line x1={gx + 3.5} x2={gx + 3.5} y1={y + 7} y2={y + h - 7} stroke="var(--onaccent)" strokeWidth={1.4} />
      <line x1={gx + 6.5} x2={gx + 6.5} y1={y + 7} y2={y + h - 7} stroke="var(--onaccent)" strokeWidth={1.4} />
    </g>
  );
  return (
    <g onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ touchAction: "none" }}>
      <rect ref={stripRef} x={x} y={y} width={w} height={h}
        fill="var(--pre)" stroke="var(--line)" onPointerDown={down("jump")} />
      {miniBars}
      <rect x={winX} y={y} width={winW} height={h} fill="var(--selected)"
        fillOpacity={0.75} stroke="var(--accent)"
        onPointerDown={down("pan")} style={{ cursor: "grab", touchAction: "none" }} />
      {grip(leftGripX, "left")}
      {grip(rightGripX, "right")}
    </g>
  );
}

export function RunsBarChart({ runs, selected, onSelect }) {
  const [wrapRef, width, wrapNode] = useWidth();
  const [win, setWin] = useState(null);
  const data = chartData(runs, selected);
  const brush = showBrush(data.length);
  const height = brush ? 264 : 232;
  const { activeKey, announcedKey, tipRef, hover, focusAt, clearPointer, clearAll } = useChartTip(wrapNode, width, height);
  if (!data.length) return <div className="empty" style={{ minHeight: 120 }}>No runs in scope.</div>;

  const sig = data.map((d) => d.run_id).join("|");
  const kept = brushWindow(win, sig);
  const range = brush ? clampBrush(kept || [0, data.length - 1], data.length) : [0, data.length - 1];
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
  const activeIdx = view.findIndex((d) => d.run_id === activeKey);
  const active = activeIdx >= 0 ? view[activeIdx] : null;
  const announcedIdx = view.findIndex((d) => d.run_id === announcedKey);
  const announced = announcedIdx >= 0 ? view[announcedIdx] : null;
  // Keys only count on the chart itself. The brush sliders inside it
  // handle their own. Enter and click selection stay with this chart.
  const onKey = makeChartKeyHandler({
    activeIdx, count: view.length, clearAll, guardTarget: true,
    focusAtIndex: (n) => focusAt(view[n].run_id, left + n * band + band / 2, top + plotH / 3),
    onEnter: () => { if (active && active.run_id && onSelect) onSelect(active.run_id); },
  });

  return (
    <BarChartShell wrapRef={wrapRef} width={width} height={height}
      ariaLabel={"Stacked bar chart of model and overhead seconds for " + view.length
        + " runs. Left and right arrows step through runs, Enter opens one."}
      onKeyDown={onKey} onBlur={clearAll} clearPointer={clearPointer}
      tipRef={tipRef} tip={active ? <ChartTip d={active} /> : null}
      announced={announced ? runSummary(announced) : ""}
      beforePlot={<YGrid ticks={ticks} y={y} left={left} plotW={plotW} format={(v) => fmtTickSec(v, yStep)} />}
      afterPlot={(
        <g>
          {labels.map((i) => (
            <text key={"x" + i} x={left + i * band + band / 2} y={base + 16}
              textAnchor="middle" style={TICK_STYLE}>{view[i].time}</text>
          ))}
          {brush ? (
            <BrushStrip data={data} range={range} onChange={(r) => setWin({ sig, range: r })}
              x={left} y={height - 24} w={plotW} totalMax={maxAll} />
          ) : null}
        </g>
      )}>
      <line x1={left} x2={left + plotW} y1={base} y2={base} stroke="var(--line)" />
      {view.map((d, i) => (
        <StackedBar key={d.run_id} bandX={left + i * band} band={band} top={top} plotH={plotH}
          active={d.run_id === activeKey}
          bx={left + i * band + (band - barW) / 2} barW={barW}
          lowY={y(d.model_s)} lowH={base - y(d.model_s)} lowFill="var(--barmodel)"
          upY={y(d.model_s + d.overhead_s)} upH={y(d.model_s) - y(d.model_s + d.overhead_s)}
          upFill="var(--barover)" segProps={segProps(d)} />
      ))}
      <HitBands items={view} left={left} top={top} band={band} plotH={plotH}
        keyOf={(d) => d.run_id} hover={hover}
        onPick={(d) => { if (d.run_id && onSelect) onSelect(d.run_id); }} />
    </BarChartShell>
  );
}

export function RecentRunsChart({ data, onSelect, scope }) {
  const sc = scope || overviewScope(data, null);
  return <RunsBarChart runs={sc.runs} selected={data.selected} onSelect={onSelect} />;
}

export function PerCallChart({ events, provider }) {
  const [wrapRef, width, wrapNode] = useWidth();
  const height = 220;
  const { activeKey, announcedKey, tipRef, hover, focusAt, clearPointer, clearAll } = useChartTip(wrapNode, width, height);
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

  const left = 52, right = 60, top = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - top - 36;
  const maxTime = data.reduce((m, d) => Math.max(m, d.active_s + d.stalled_s), 0);
  // Only the token axis can be all-null. Time segments are always
  // numbers above, and Runs model/overhead seconds always are too.
  // No recorded token count means no token ticks, not a 0 to 1 axis.
  const tokValues = data.map((d) => d.input_tokens).filter((v) => v != null);
  const maxTok = tokValues.length ? Math.max(...tokValues) : null;
  const time = linearTicks(maxTime);
  const tok = linearTicks(maxTok, 4, true);
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
  const activeIdx = data.findIndex((d) => d.call === activeKey);
  const active = activeIdx >= 0 ? data[activeIdx] : null;
  const announcedIdx = data.findIndex((d) => d.call === announcedKey);
  const announced = announcedIdx >= 0 ? data[announcedIdx] : null;
  const onKey = makeChartKeyHandler({
    activeIdx, count: data.length, clearAll,
    focusAtIndex: (n) => focusAt(data[n].call, left + n * band + band / 2, top + plotH / 3),
  });

  return (
    <BarChartShell wrapRef={wrapRef} width={width} height={height}
      ariaLabel={"Per-call model time bars and input token line for " + data.length
        + " calls. Left and right arrows step through calls."}
      onKeyDown={onKey} onBlur={clearAll} clearPointer={clearPointer}
      tipRef={tipRef} tip={active ? <PerCallTip d={active} /> : null}
      announced={announced ? callSummary(announced) : ""}
      beforePlot={(
        <g>
          <YGrid ticks={time.ticks} y={yT} left={left} plotW={plotW} format={(v) => fmtTickSec(v, time.step)} />
          {tok.ticks.map((t) => (
            <text key={"k" + t} x={left + plotW + 8} y={yK(t) + 4} textAnchor="start" style={TICK_STYLE}>
              {fmt(t)}
            </text>
          ))}
        </g>
      )}
      afterPlot={(
        <g>
          {labels.map((i) => (
            <text key={"x" + i} x={left + i * band + band / 2} y={base + 16}
              textAnchor="middle" style={TICK_STYLE}>{data[i].label}</text>
          ))}
          <text x={left + plotW / 2} y={height - 2} textAnchor="middle" style={TICK_STYLE}>call</text>
        </g>
      )}>
      <line x1={left} x2={left + plotW} y1={base} y2={base} stroke="var(--line)" />
      {data.map((d, i) => (
        <StackedBar key={d.call} bandX={left + i * band} band={band} top={top} plotH={plotH}
          active={d.call === activeKey} noPointer
          bx={left + i * band + (band - barW) / 2} barW={barW}
          lowY={yT(d.active_s)} lowH={base - yT(d.active_s)} lowFill="var(--barmodel)"
          upY={yT(d.active_s + d.stalled_s)} upH={yT(d.active_s) - yT(d.active_s + d.stalled_s)}
          upFill="var(--barstalled)" />
      ))}
      {linePath ? (
        <path d={linePath} fill="none" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />
      ) : null}
      {data.map((d, i) => (d.input_tokens == null ? null : (
        <circle key={"dot" + d.call} cx={left + i * band + band / 2} cy={yK(d.input_tokens)} r={3}
          fill="var(--card)" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />
      )))}
      <HitBands items={data} left={left} top={top} band={band} plotH={plotH}
        keyOf={(d) => d.call} hover={hover} />
    </BarChartShell>
  );
}
