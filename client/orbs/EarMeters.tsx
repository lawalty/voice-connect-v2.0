import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './ear-meters.css';

const COLORS = [
  '#ff321d', '#ff3d16', '#ff4c0d', '#ff6400',
  '#ff7c00', '#ff9400', '#ffae00', '#ffc700',
  '#dce800', '#b2f000', '#83f400', '#56f500',
  '#43f600', '#40f700', '#40f700', '#40f700',
];
const SILENT = () => 0;

/** Both ears mirror the mono microphone. A fast attack and short release keep
 * real sounds legible; quiet frames and interrupted capture return to grey. */
export default function EarMeters({ getLevel = SILENT }: { getLevel?: () => number }) {
  const latest = useRef(getLevel);
  latest.current = getLevel;
  const [segments, setSegments] = useState(0);
  useEffect(() => {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, last = 0, envelope = 0;
    const draw = (time: number) => {
      frame = 0;
      if (document.hidden) return;
      if (!last || time - last >= 32) {
        const elapsed = last ? Math.min(100, time - last) : 32;
        last = time;
        const raw = latest.current();
        const level = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
        envelope = reducedMotion.matches ? level : Math.max(level, envelope * Math.exp(-elapsed / 140));
        setSegments(Math.round(envelope * COLORS.length));
      }
      frame = requestAnimationFrame(draw);
    };
    const visibility = () => {
      cancelAnimationFrame(frame); frame = 0; last = 0; envelope = 0; setSegments(0);
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  return <div className="orb-ear-meters" aria-hidden="true">
    {(['left', 'right'] as const).map(side => <div key={side} className={`orb-ear-meter orb-ear-${side}`} data-lit-segments={segments}>
      {COLORS.map((color, index) => <span key={index} className={`orb-ear-bar${index < segments ? ' is-lit' : ''}`} style={{ '--ear-color': color } as CSSProperties} />)}
    </div>)}
  </div>;
}
