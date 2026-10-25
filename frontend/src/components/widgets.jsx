import React from "react";

export function StatusPill({ status, extra }) {
  const known = ["completed", "failed", "interrupted", "timeout", "running"].includes(status) ? status : "unknown";
  return <span className={"pill st-" + known}>{(status || "unknown") + (extra ? " · " + extra : "")}</span>;
}

export function Chip({ text, cls, title }) {
  return <span className={"pill" + (cls ? " " + cls : "")} title={title}>{text}</span>;
}

const svgProps = {
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false,
};

export function NavIcon({ view }) {
  if (view === "overview") return (<svg className="navIcon" {...svgProps}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>);
  if (view === "runs") return (<svg className="navIcon" {...svgProps}><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></svg>);
  if (view === "compare") return (<svg className="navIcon" {...svgProps}><path d="M3 20h18" /><rect x="5" y="11" width="5" height="9" /><rect x="14" y="4" width="5" height="16" /></svg>);
  return (<svg className="navIcon" {...svgProps}><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>);
}

export function StatIcon({ kind }) {
  if (kind === "wall") return (<svg className="statIcon" {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
  if (kind === "model") return (<svg className="statIcon" {...svgProps}><rect x="7" y="7" width="10" height="10" rx="1.5" /><rect x="10.2" y="10.2" width="3.6" height="3.6" /><path d="M10 2v5" /><path d="M14 2v5" /><path d="M10 17v5" /><path d="M14 17v5" /><path d="M2 10h5" /><path d="M2 14h5" /><path d="M17 10h5" /><path d="M17 14h5" /></svg>);
  if (kind === "overhead") return (<svg className="statIcon" {...svgProps}><polygon points="9.6,5.4 10.9,5.1 10.6,2.9 13.4,2.9 13.1,5.1 14.4,5.4 15.0,5.7 16.1,6.3 17.4,4.6 19.4,6.6 17.7,7.9 18.3,9.0 18.6,9.6 18.9,10.9 21.1,10.6 21.1,13.4 18.9,13.1 18.6,14.4 18.3,15.0 17.7,16.1 19.4,17.4 17.4,19.4 16.1,17.7 15.0,18.3 14.4,18.6 13.1,18.9 13.4,21.1 10.6,21.1 10.9,18.9 9.6,18.6 9.0,18.3 7.9,17.7 6.6,19.4 4.6,17.4 6.3,16.1 5.7,15.0 5.4,14.4 5.1,13.1 2.9,13.4 2.9,10.6 5.1,10.9 5.4,9.6 5.7,9.0 6.3,7.9 4.6,6.6 6.6,4.6 7.9,6.3 9.0,5.7" /><circle cx="12" cy="12" r="3.2" /></svg>);
  return (<svg className="statIcon" {...svgProps}><path d="M12 3l9 5-9 5-9-5 9-5Z" /><path d="M3 13l9 5 9-5" /><path d="M3 18l9 5 9-5" /></svg>);
}

export function MoonIcon() {
  return (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>);
}

export function SunIcon() {
  return (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
}
