import React from "react";
import {
  Bar, BarChart, Brush, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { chartData, fmt, fmtDur, fmtDurExact, fmtSec, localTime, overviewScope, perCallSeries, shortText, showBrush } from "../format.js";

function ChartTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
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

export function RunsBarChart({ runs, selected, onSelect }) {
  const data = chartData(runs, selected);
  if (!data.length) return <div className="empty" style={{ minHeight: 120 }}>No runs in scope.</div>;
  const pick = (entry) => {
    const id = (entry && entry.payload && entry.payload.run_id) || (entry && entry.run_id);
    if (id && onSelect) onSelect(id);
  };
  const cellProps = (entry) => ({
    fillOpacity: entry.greyed ? 0.45 : 1,
    stroke: entry.isSelected ? "var(--ink)" : "transparent",
    strokeWidth: entry.isSelected ? 2 : 0,
    cursor: "pointer",
    onClick: () => { if (entry.run_id && onSelect) onSelect(entry.run_id); },
  });
  return (
    <div style={{ width: "100%", height: showBrush(data.length) ? 264 : 232 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} onClick={(e) => { if (e && e.activePayload) pick(e.activePayload[0]); }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v) => Number(v).toFixed(v >= 10 ? 0 : 1) + "s"} />
          <Tooltip content={<ChartTip />} cursor={{ fill: "var(--chip)", opacity: 0.5 }} />
          <Bar dataKey="model_s" name="Model" stackId="t" fill="var(--barmodel)" isAnimationActive={false}>
            {data.map((d) => <Cell key={d.run_id + "-m"} {...cellProps(d)} />)}
          </Bar>
          <Bar dataKey="overhead_s" name="Overhead" stackId="t" fill="var(--barover)" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.run_id + "-o"} {...cellProps(d)} />)}
          </Bar>
          {showBrush(data.length)
            ? <Brush dataKey="time" height={24} travellerWidth={10} stroke="var(--accent)" fill="var(--pre)" />
            : null}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RecentRunsChart({ data, onSelect, scope }) {
  const sc = scope || overviewScope(data, null);
  return <RunsBarChart runs={sc.runs} selected={data.selected} onSelect={onSelect} />;
}

function PerCallTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="chartTip">
      <div className="chartTipTitle">{"Call " + d.call}</div>
      <div>{"Model: " + (d.model_ms == null ? "not reported" : fmtSec(d.model_ms))}</div>
      <div>{"Input: " + fmt(d.input_tokens) + " tokens"}</div>
      <div>{"Cached: " + fmt(d.cached_tokens) + " tokens"}</div>
    </div>
  );
}

export function PerCallChart({ events, provider }) {
  if (provider === "claude-code") {
    return <p className="note">Claude Code doesn't report per-call time</p>;
  }
  const series = perCallSeries(events, provider);
  if (!series.length) return <div className="empty" style={{ minHeight: 80 }}>No calls yet.</div>;
  const data = series.map((d) => ({
    ...d,
    label: String(d.call),
    model_s: d.model_ms == null ? 0 : d.model_ms / 1000,
  }));
  return (
    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} label={{ value: "call", position: "insideBottom", offset: -2, fontSize: 11, fill: "var(--muted)" }} />
          <YAxis yAxisId="time" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v) => Number(v).toFixed(v >= 10 ? 0 : 1) + "s"} />
          <YAxis yAxisId="tokens" orientation="right" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v) => fmt(v)} />
          <Tooltip content={<PerCallTip />} cursor={{ fill: "var(--chip)", opacity: 0.5 }} />
          <Bar yAxisId="time" dataKey="model_s" name="Model time" fill="var(--barmodel)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="tokens" type="monotone" dataKey="input_tokens" name="Input tokens" stroke="var(--ink)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
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
          </React.Fragment>
        );
      })}
      <text x={0} y={H - 5} className="chartText">call 1</text>
      <text x={W} y={H - 5} textAnchor="end" className="chartText">{"call " + chrono.length}</text>
    </svg>
  );
}
