import React, { useEffect, useRef, useState } from "react";
import { shouldCloseTourOnEscape } from "../format.js";

// Non-modal tour card. Steps arrive as plain data from
// walkthroughSteps in format.js, already snapshotted by the
// caller for this tour. Each step optionally names a route
// to visit and a CSS selector to outline. The shade and ring
// never take clicks, so the page stays usable behind the
// card. Nothing here stores state beyond the step index.
function sameBox(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a.ring, rb = b.ring;
  const ringSame = (!ra && !rb) || (ra && rb
    && ra.top === rb.top && ra.left === rb.left
    && ra.width === rb.width && ra.height === rb.height
    && ra.bottom === rb.bottom);
  return ringSame
    && a.card.top === b.card.top && a.card.left === b.card.left
    && a.card.width === b.card.width;
}

export default function Walkthrough({ steps, onNavigate, onClose }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState(null);
  const cardRef = useRef(null);
  const headingRef = useRef(null);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusedStepRef = useRef(-1);
  const step = steps[index];

  useEffect(() => {
    if (step && step.route) navigateRef.current(step.route);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // The card starts hidden until its first measure lands, and a
    // hidden heading cannot take focus. Focus once per step, as
    // soon as the card has a real position.
    if (box && focusedStepRef.current !== index && headingRef.current) {
      focusedStepRef.current = index;
      headingRef.current.focus({ preventScroll: true });
    }
  }, [index, box]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && shouldCloseTourOnEscape(e)) {
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!step) return undefined;
    // Never show the previous step's ring or card position on
    // the new page while this step's target is still hunting.
    setBox(null);
    let cancelled = false;
    let timer = null;
    let raf = 0;
    let tries = 0;

    const place = (rect) => {
      const margin = 8;
      const gap = 14;
      const narrow = window.innerWidth <= 560;
      const cardW = narrow
        ? window.innerWidth - margin * 2
        : Math.min(340, window.innerWidth - margin * 2);
      const cardH = cardRef.current ? cardRef.current.offsetHeight : 170;
      if (narrow) {
        return {
          ring: rect,
          card: { top: Math.max(margin, window.innerHeight - cardH - margin),
                  left: margin, width: cardW },
        };
      }
      if (!rect) {
        return {
          ring: null,
          card: { top: Math.max(margin, (window.innerHeight - cardH) / 2),
                  left: Math.max(margin, (window.innerWidth - cardW) / 2),
                  width: cardW },
        };
      }
      let top = rect.bottom + gap;
      if (top + cardH > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - gap - cardH);
      }
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - cardW - margin));
      return { ring: rect, card: { top, left, width: cardW } };
    };

    // Measures the step target and returns it when visible.
    // With fallback set, a missing target centres the card.
    const measure = (fallback = false) => {
      if (cancelled) return null;
      const el = document.querySelector(step.target);
      const r = el ? el.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) {
        if (fallback) setBox((prev) => {
          const next = place(null);
          return sameBox(prev, next) ? prev : next;
        });
        return null;
      }
      const rect = { top: r.top - 6, left: r.left - 6,
                     width: r.width + 12, height: r.height + 12,
                     bottom: r.bottom + 6 };
      setBox((prev) => {
        const next = place(rect);
        return sameBox(prev, next) ? prev : next;
      });
      return el;
    };

    const scheduleMeasure = () => {
      if (cancelled || raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measure(true); });
    };

    const find = () => {
      if (cancelled) return;
      const el = measure(false);
      if (el) {
        el.scrollIntoView({ block: "center" });
        // Measure now and again next frame. A hidden tab may
        // throttle animation frames, and the card must not stay
        // invisible at its placeholder position meanwhile.
        measure(false);
        requestAnimationFrame(() => measure(false));
      } else if (tries++ < 10) {
        timer = setTimeout(find, 50);
      } else {
        measure(true);
      }
    };
    find();
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure);
    };
  }, [index, step]);

  if (!step) return null;
  const last = index === steps.length - 1;
  return (
    <>
      <div className="tourShade" aria-hidden="true" />
      {box && box.ring ? (
        <div className="tourRing" aria-hidden="true" style={{
          top: box.ring.top, left: box.ring.left,
          width: box.ring.width, height: box.ring.height,
        }} />
      ) : null}
      <div ref={cardRef} className="tourCard" role="dialog" aria-modal="false"
        aria-labelledby="tourTitle" aria-describedby="tourBody"
        style={box ? box.card : { top: 8, left: 8, visibility: "hidden" }}>
        <div className="tourStep">{"Step " + (index + 1) + " of " + steps.length}</div>
        <h2 id="tourTitle" ref={headingRef} tabIndex={-1}>{step.title}</h2>
        <p id="tourBody">{step.body}</p>
        <div className="tourButtons">
          <button className="btn" type="button" onClick={onClose}>Skip</button>
          <span className="spacer" />
          <button className="btn" type="button" disabled={index === 0}
            onClick={() => setIndex(index - 1)}>Back</button>
          {last
            ? <button className="btn" type="button" onClick={onClose}>Done</button>
            : <button className="btn" type="button" onClick={() => setIndex(index + 1)}>Next</button>}
        </div>
      </div>
    </>
  );
}
