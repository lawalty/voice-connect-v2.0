import { useEffect, useRef } from 'react';
import type { AcousticSignal, VoicePhase } from '../contract/types';
import { OrbAcousticMotion, orbMotionShape } from './orb-acoustics';

const palette: Record<VoicePhase, [number, number, number]> = {
  off: [97, 180, 179], starting: [111, 188, 191], listening: [118, 215, 198], hearing: [111, 231, 205],
  finalizing: [222, 183, 122], thinking: [223, 182, 123], speaking: [167, 150, 245],
  reconnecting: [222, 177, 113], paused: [125, 148, 164], error: [225, 134, 125],
};

interface OrbProps {
  phase: VoicePhase;
  signal: AcousticSignal | null;
  asleep?: boolean;
  waking?: boolean;
  onWake?: () => void;
  wakeDisabled?: boolean;
}

export default function Orb({ phase, signal, asleep = false, waking = false, onWake, wakeDisabled = false }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ phase, signal, asleep, waking });
  const repaint = useRef<() => void>(() => {});
  latest.current = { phase, signal, asleep, waking };
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, radius = 150, size = 400, lastFrame = 0, flow = 0;
    let lastSignal: AcousticSignal | null | undefined;
    let reducedPaintState: string | undefined;
    let wasAsleep = latest.current.asleep;
    let sleepBlend = wasAsleep ? 1 : 0;
    let wakeAt = -Infinity;
    let sleepAt = -Infinity;
    const acoustics = new OrbAcousticMotion();
    const color = [97, 180, 179];
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      size = canvas.clientWidth;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = size * dpr; canvas.height = size * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      radius = size * .305;
      reducedPaintState = undefined;
      schedule();
    };
    const draw = (time: number) => {
      frame = 0;
      if (document.hidden) return;
      if (lastFrame && time - lastFrame < 33) { schedule(); return; }
      const elapsed = lastFrame ? Math.min(66, time - lastFrame) : 33;
      lastFrame = time;
      const current = latest.current;
      // Only a transition wakes the orb; a decorative or already-active mount stays settled.
      if (wasAsleep && !current.asleep && !motion.matches) wakeAt = time;
      if (!wasAsleep && current.asleep && !motion.matches) sleepAt = time;
      if (current.asleep) wakeAt = -Infinity;
      else sleepAt = -Infinity;
      wasAsleep = current.asleep;
      sleepBlend = motion.matches ? Number(current.asleep) : sleepBlend + (Number(current.asleep) - sleepBlend) * (1 - Math.exp(-elapsed / 360));
      const wakeProgress = (time - wakeAt) / 1350;
      const wakeActive = !motion.matches && wakeProgress >= 0 && wakeProgress < 1;
      // A quick, unmistakable inhale followed by a longer, smooth settle.
      const wakeBloom = !wakeActive ? 0 : wakeProgress < .22
        ? Math.sin(wakeProgress / .22 * Math.PI / 2)
        : (1 + Math.cos((wakeProgress - .22) / .78 * Math.PI)) / 2;
      const sleepProgress = (time - sleepAt) / 1500;
      const fallingAsleep = !motion.matches && sleepProgress >= 0 && sleepProgress < 1;
      // One soft exhale, then the atmosphere folds inward. Capture has already
      // stopped; this is visual settling only and can be interrupted by waking.
      const sleepExhale = fallingAsleep ? Math.sin(Math.min(1, sleepProgress / .65) * Math.PI) : 0;
      const input = current.asleep ? null : current.signal;
      if (input !== lastSignal) { lastSignal = input; acoustics.observe(input, time); }
      const shape = orbMotionShape(acoustics.sample(time), motion.matches);
      const voice = shape.radiance * (1 - sleepBlend);
      flow += elapsed * shape.flowRate * (1 - sleepBlend * .78 + wakeBloom * 3.4);
      const t = motion.matches ? 0 : flow;
      const paintState = `${current.phase}:${current.asleep}:${current.waking}`;
      if (motion.matches && reducedPaintState === paintState) return;
      reducedPaintState = motion.matches ? paintState : undefined;
      const target = palette[current.phase];
      for (let i = 0; i < 3; i++) color[i] = motion.matches ? target[i] : color[i] + (target[i] - color[i]) * .035;
      const rgb = color.map(value => Math.round(value + (255 - value) * wakeBloom * .3)).join(',');
      const light = 1 - sleepBlend * .42 + wakeBloom * 1.7 + voice * 1.5 + sleepExhale * .35;
      const alpha = (opacity: number) => `rgba(${rgb},${Math.min(1, opacity * light)})`;
      const r = radius * (1 - sleepBlend * .12 + Math.sin(t * 1.2) * (.019 - sleepBlend * .007) + shape.expansion * (1 - sleepBlend) + wakeBloom * .18 + sleepExhale * .055);
      ctx.clearRect(0, 0, size, size);
      ctx.save(); ctx.translate(size / 2, size / 2);
      const outer = Math.min(size * .475, r * (1.55 + voice * .18));
      const halo = ctx.createRadialGradient(0, 0, r * .65, 0, 0, outer);
      halo.addColorStop(0, alpha(0)); halo.addColorStop(.35, alpha(.065 + wakeBloom * .10 + voice * .09)); halo.addColorStop(1, alpha(0));
      ctx.fillStyle = halo; ctx.fillRect(-size / 2, -size / 2, size, size);
      // These veils follow the measured voice envelope rather than an invented
      // talking loop. Geometry scales down with the Messenger orb, inside its bounds.
      if (voice > .005) {
        const gap = outer - r;
        for (let veil = 0; veil < 3; veil++) {
          ctx.beginPath();
          for (let point = 0; point <= 96; point++) {
            const angle = point / 96 * Math.PI * 2;
            const distortion = (Math.sin(angle * 3 + t * 2.4 + veil * 1.3) + Math.cos(angle * 5 - t * 1.7 + veil) * .45) * gap * .12 * voice;
            const distance = r + gap * (.23 + veil * .27) + distortion;
            const x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
            if (point === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = alpha(voice * (.15 - veil * .035));
          ctx.lineWidth = Math.max(.65, size / 400) * (1.1 - veil * .2); ctx.stroke();
        }
      }
      if (fallingAsleep) {
        for (const delay of [0, 180]) {
          const progress = (time - sleepAt - delay) / 1200;
          if (progress <= 0 || progress >= 1) continue;
          const inward = progress * progress * (3 - 2 * progress);
          ctx.strokeStyle = alpha(Math.sin(progress * Math.PI) * .55);
          ctx.lineWidth = Math.max(.7, size / 400) * (1.5 - progress * .6);
          ctx.beginPath(); ctx.arc(0, 0, radius * (1.48 - inward * .62), 0, Math.PI * 2); ctx.stroke();
        }
      }
      if (wakeActive) {
        // Two outward ripples stay inside the canvas and fade instead of flashing.
        for (const delay of [0, 180]) {
          const progress = (time - wakeAt - delay) / 1100;
          if (progress <= 0 || progress >= 1) continue;
          const spread = 1 - (1 - progress) ** 3;
          const opacity = Math.sin(progress * Math.PI) * (1 - progress) * .8;
          ctx.strokeStyle = `rgba(${rgb},${opacity})`;
          ctx.lineWidth = 2.2 - progress * 1.5;
          ctx.shadowColor = `rgba(${rgb},${opacity})`; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.arc(0, 0, radius * (.97 + spread * .55), 0, Math.PI * 2); ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }
      const body = ctx.createRadialGradient(-r * .28, -r * .35, 0, 0, 0, r);
      body.addColorStop(0, alpha(.19)); body.addColorStop(.54, alpha(.085)); body.addColorStop(.89, alpha(.14)); body.addColorStop(1, alpha(.025));
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
          const wave = (Math.sin(angle * 3 + t * 2.1 + latitude * 5 + Math.sin(t) * shape.pitchCurl * .12) * (3.4 + shape.pitchCurl + wakeBloom * 2.8 + voice * 5.5) + Math.cos(angle * 5 - t + latitude * 3) * (2.2 + shape.rhythm + voice * 2.5)) * size / 400;
          const x = Math.cos(angle) * (width + wave * Math.cos(latitude));
          const py = y + front * width * .28 + wave * .75;
          if (step === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
        }
        ctx.strokeStyle = alpha(.085 + Math.pow(Math.cos(latitude), 2) * .13);
        ctx.lineWidth = .65; ctx.stroke();
      }
      for (let i = 0; i < 90; i++) {
        const y = 1 - i / 89 * 2, latitudeRadius = Math.sqrt(1 - y * y), angle = i * 2.399963 + t * .32;
        const z = Math.sin(angle) * latitudeRadius;
        if (z < -.15) continue;
        const x = Math.cos(angle) * latitudeRadius * r;
        ctx.fillStyle = alpha(.15 + Math.max(0, z) * .55);
        ctx.beginPath(); ctx.arc(x, y * r, (.7 + Math.max(0, z) * .55) * (1 + wakeBloom * .4), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      const edge = ctx.createLinearGradient(-r, -r, r, r);
      edge.addColorStop(0, alpha(.42)); edge.addColorStop(.48, alpha(.015)); edge.addColorStop(1, alpha(.2));
      ctx.strokeStyle = edge; ctx.lineWidth = .8 + wakeBloom * .9; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      if (!motion.matches) schedule();
    };
    const invalidate = () => { reducedPaintState = undefined; schedule(); };
    const motionChanged = () => { wakeAt = -Infinity; sleepAt = -Infinity; invalidate(); };
    const visibilityChanged = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else { lastFrame = 0; invalidate(); }
    };
    repaint.current = invalidate;
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    motion.addEventListener('change', motionChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      motion.removeEventListener('change', motionChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      repaint.current = () => {};
    };
  }, []);
  useEffect(() => { repaint.current(); }, [phase, asleep, waking]);
  const presence = waking ? 'waking' : asleep ? 'sleeping' : 'awake';
  return <div className={`orb-stage phase-${phase}${asleep ? ' orb-sleeping' : ''}${waking ? ' orb-waking' : ''}`} data-presence={presence}>
    <span className="orb-orbit orbit-one" aria-hidden="true" /><span className="orb-orbit orbit-two" aria-hidden="true" />
    <canvas ref={canvasRef} className="orb-canvas" aria-hidden="true" />
    <span className="orb-coordinate coordinate-left" aria-hidden="true">N</span><span className="orb-coordinate coordinate-right" aria-hidden="true">P</span>
    {onWake && <button type="button" className="orb-wake-button" disabled={wakeDisabled} aria-label="Wake NorthPointe" onClick={onWake}>
      {asleep && !wakeDisabled && <span className="orb-wake-hint" aria-hidden="true">Tap to wake</span>}
    </button>}
  </div>;
}
