import React from "react";

// Shared filter controls. One URL-backed state is read
// by Overview and Runs; `extra` renders Runs-only status/mode selects.
export function FilterBar({ state, providers, models, onChange, extra }) {
  return (
    <div className="filterRow">
      <label htmlFor="sharedPromptFilter">Filter</label>
      <input type="search" id="sharedPromptFilter" placeholder="Prompt text…" size="18"
        value={state.q} onChange={(e) => onChange({ q: e.target.value })} />
      <label htmlFor="sharedProviderFilter">Provider</label>
      <select id="sharedProviderFilter" value={state.provider} onChange={(e) => onChange({ provider: e.target.value })}>
        <option value="">All</option>
        {providers.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <label htmlFor="sharedModelFilter">Model</label>
      <select id="sharedModelFilter" value={state.model} onChange={(e) => onChange({ model: e.target.value })}>
        <option value="">All</option>
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <label htmlFor="sharedFromFilter">From</label>
      <input type="date" id="sharedFromFilter" value={state.from || ""}
        onChange={(e) => onChange({ from: e.target.value })} />
      <label htmlFor="sharedToFilter">To</label>
      <input type="date" id="sharedToFilter" value={state.to || ""}
        onChange={(e) => onChange({ to: e.target.value })} />
      {extra}
    </div>
  );
}
