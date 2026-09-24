import { useEffect, useRef } from 'react';
import type { AcousticSignal, VoicePhase } from '../contract/types';
import { OrbAcousticMotion, orbMotionShape } from './orb-acoustics';

const palette: Record<VoicePhase, [number, number, number]> = {
  off: [97, 180, 179], starting: [111, 188, 191], listening: [118, 215, 198], hearing: [111, 231, 205],
  finalizing: [222, 183, 122], thinking: [223, 182, 123], speaking: [167, 150, 245],
  reconnecting: [222, 177, 113], paused: [125, 148, 164], error: [225, 134, 125],
};

export default function Orb({ phase, signal }: { phase: VoicePhase; signal: AcousticSignal | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ phase, signal });
  latest.current = { phase, signal };
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, radius = 150, size = 400, lastFrame = 0, flow = 0;
    let lastSignal: AcousticSignal | null | undefined;
    let reducedPaintPhase: VoicePhase | undefined;
    const acoustics = new OrbAcousticMotion();
    const color = [97, 180, 179];
    const resize = () => {
      size = canvas.clientWidth;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = size * dpr; canvas.height = size * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      radius = size * .305;
      reducedPaintPhase = undefined;
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const draw = (time: number) => {
      if (document.hidden || time - lastFrame < 33) { frame = requestAnimationFrame(draw); return; }
      const elapsed = Math.min(66, time - lastFrame);
      lastFrame = time;
      if (latest.current.signal !== lastSignal) { lastSignal = latest.current.signal; acoustics.observe(lastSignal, time); }
      const shape = orbMotionShape(acoustics.sample(time), motion.matches);
      flow += elapsed * shape.flowRate;
      const t = motion.matches ? 0 : flow;
      if (motion.matches && reducedPaintPhase === latest.current.phase) { frame = requestAnimationFrame(draw); return; }
      reducedPaintPhase = motion.matches ? latest.current.phase : undefined;
      const target = palette[latest.current.phase];
      for (let i = 0; i < 3; i++) color[i] = motion.matches ? target[i] : color[i] + (target[i] - color[i]) * .035;
      const rgb = color.map(Math.round).join(',');
      const r = radius * (1 + Math.sin(t * 1.2) * .019 + shape.expansion);
      ctx.clearRect(0, 0, size, size);
      ctx.save(); ctx.translate(size / 2, size / 2);
      const halo = ctx.createRadialGradient(0, 0, r * .65, 0, 0, r * 1.62);
      halo.addColorStop(0, `rgba(${rgb},0)`); halo.addColorStop(.35, `rgba(${rgb},.065)`); halo.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = halo; ctx.fillRect(-size / 2, -size / 2, size, size);
      const body = ctx.createRadialGradient(-r * .28, -r * .35, 0, 0, 0, r);
      body.addColorStop(0, `rgba(${rgb},.19)`); body.addColorStop(.54, `rgba(${rgb},.085)`); body.addColorStop(.89, `rgba(${rgb},.14)`); body.addColorStop(1, `rgba(${rgb},.025)`);
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'screen';
      for (let line = 0; line < 58; line++) {
        const latitude = (line / 57 - .5) * Math.PI;
        const width = Math.cos(latitude) * r;
        const y = Math.sin(latitude) * r;
        ctx.beginPath();
        for (let step = 0; step <= 120; step++) {
          const angle = step / 120 * Math.PI * 2;
          const front = Math.sin(angle);
          const wave = Math.sin(angle * 3 + t * 2.1 + latitude * 5 + Math.sin(t) * shape.pitchCurl * .12) * (3.4 + shape.pitchCurl) + Math.cos(angle * 5 - t + latitude * 3) * (2.2 + shape.rhythm);
          const x = Math.cos(angle) * (width + wave * Math.cos(latitude));
          const py = y + front * width * .28 + wave * .75;
          if (step === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
        }
        ctx.strokeStyle = `rgba(${rgb},${.085 + Math.pow(Math.cos(latitude), 2) * .13})`;
        ctx.lineWidth = .65; ctx.stroke();
      }
      for (let i = 0; i < 90; i++) {
        const y = 1 - i / 89 * 2, latitudeRadius = Math.sqrt(1 - y * y), angle = i * 2.399963 + t * .32;
        const z = Math.sin(angle) * latitudeRadius;
        if (z < -.15) continue;
        const x = Math.cos(angle) * latitudeRadius * r;
        ctx.fillStyle = `rgba(${rgb},${.15 + Math.max(0, z) * .55})`;
        ctx.beginPath(); ctx.arc(x, y * r, .7 + Math.max(0, z) * .55, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      const edge = ctx.createLinearGradient(-r, -r, r, r);
      edge.addColorStop(0, `rgba(${rgb},.42)`); edge.addColorStop(.48, `rgba(${rgb},.015)`); edge.addColorStop(1, `rgba(${rgb},.2)`);
      ctx.strokeStyle = edge; ctx.lineWidth = .8; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  return <div className={`orb-stage phase-${phase}`} aria-hidden="true"><span className="orb-orbit orbit-one" /><span className="orb-orbit orbit-two" /><canvas ref={canvasRef} className="orb-canvas" /><span className="orb-coordinate coordinate-left">N</span><span className="orb-coordinate coordinate-right">P</span></div>;
}
