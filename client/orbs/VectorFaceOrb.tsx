import { useEffect, useId, useRef } from 'react';
import { useAgentName } from '../agent-name';
import type { OrbProps } from './ClassicOrb';
import type { VectorFacePack } from './packs';
import { statusOrbState } from './status';
import { SILENT_MOUTH, type MouthPose } from './speech';
import { buildVectorScene, type VectorInput, type VectorScene } from './vector-model';
import { VectorRenderer } from './vector-renderer';
import './vector-face.css';

export interface VectorFaceOrbProps extends OrbProps {
  pack: VectorFacePack; motion: number; getSpeech?: () => MouthPose; getMicrophoneLevel?: () => number;
  /** Fixed clock for the authoring/review harness; not enabled by pack contents. */
  clockMs?: number;
}
export default function VectorFaceOrb(props: VectorFaceOrbProps) {
  const { pack, phase, asleep = false, waking = false, onWake, onStandby, onResume, wakeDisabled = false } = props;
  const state = statusOrbState(phase, asleep, waking), standby = state === 'standby', agentName = useAgentName();
  const latest = useRef(props); latest.current = props;
  const stageRef = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null), surfaceRef = useRef<HTMLDivElement>(null), haloRef = useRef<HTMLSpanElement>(null);
  const repaint = useRef(() => {});
  const prefix = `vector-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  useEffect(() => {
    const svg = svgRef.current, surface = surfaceRef.current, stage = stageRef.current, halo = haloRef.current;
    if (!svg || !surface || !stage || !halo) return;
    const renderer = new VectorRenderer(svg, pack, prefix), media = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, visible = true, origin: number | undefined, lastScene: VectorScene | undefined;
    let previous = { state: statusOrbState(latest.current.phase, latest.current.asleep, latest.current.waking), asleep: Boolean(latest.current.asleep), waking: Boolean(latest.current.waking) };
    const transitions: Pick<VectorInput, 'blend' | 'wakeAtMs' | 'sleepAtMs' | 'delightedAtMs'> = {};
    let stateAtMs = 0;
    const styles = new Map<string, string>();
    const setStyle = (element: HTMLElement, key: string, value: string) => {
      const identity = `${element === surface ? 'surface' : element === halo ? 'halo' : 'stage'}:${key}`;
      if (styles.get(identity) !== value) { element.style.setProperty(key, value); styles.set(identity, value); }
    };
    const paint = (now: number) => {
      const current = latest.current;
      origin ??= now;
      const t = current.clockMs ?? now - origin;
      const next = statusOrbState(current.phase, current.asleep, current.waking);
      if (previous.state !== next) {
        stateAtMs = t;
        if (lastScene) transitions.blend = { from: lastScene.channels, atMs: t };
        if (previous.state === 'speaking' && next !== 'speaking') transitions.delightedAtMs = t;
        if (next === 'idle' && previous.state !== 'idle') transitions.sleepAtMs = t;
      }
      if ((previous.asleep && !current.asleep) || (!previous.waking && current.waking)) {
        if (transitions.wakeAtMs === undefined || t - transitions.wakeAtMs >= 1500) transitions.wakeAtMs = t;
      }
      // Standby, sleep, error and speech interrupt a wake; no surprise replay.
      if (!['listening', 'connecting'].includes(next)) delete transitions.wakeAtMs;
      previous = { state: next, asleep: Boolean(current.asleep), waking: Boolean(current.waking) };
      lastScene = buildVectorScene({ pack, state: next, tMs: t, stateAtMs, movement: current.motion,
        speech: current.getSpeech?.() ?? SILENT_MOUTH, reducedMotion: media.matches, ...transitions });
      renderer.draw(lastScene, next);
      const h = lastScene.orb;
      const transform = `translate(${h.x}%,${h.y}%) rotate(${h.roll}deg) scale(${h.scale})`;
      // Surface is 66% of the stage; match its translation to the full-stage ears.
      setStyle(surface, 'transform', `translate(${h.x / .66}%,${h.y / .66}%) rotate(${h.roll}deg) scale(${h.scale})`);
      setStyle(stage, '--orb-ear-transform', transform);
      setStyle(halo, 'transform', `scale(${lastScene.haloScale})`);
      setStyle(stage, '--vector-color', pack.colors[next]);
      setStyle(stage, '--vector-halo', next === 'standby' ? '#10b981' : pack.colors[next]);
    };
    const schedule = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(draw); };
    const draw = (time: number) => {
      raf = 0; if (document.hidden || !visible) return;
      paint(time); if (!media.matches && latest.current.clockMs === undefined) schedule();
    };
    const invalidate = () => { cancelAnimationFrame(raf); raf = 0; schedule(); };
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else invalidate(); };
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) invalidate(); else { cancelAnimationFrame(raf); raf = 0; }
    });
    intersection.observe(stage);
    media.addEventListener('change', invalidate); document.addEventListener('visibilitychange', visibility);
    repaint.current = invalidate;
    paint(performance.now()); schedule();
    return () => { cancelAnimationFrame(raf); intersection.disconnect(); renderer.dispose();
      media.removeEventListener('change', invalidate); document.removeEventListener('visibilitychange', visibility); repaint.current = () => {}; };
  }, [pack, prefix]);
  useEffect(() => repaint.current(), [phase, asleep, waking, props.motion, props.clockMs, props.getSpeech]);
  const action = standby ? onResume : onStandby || onWake, disabled = standby || !onStandby ? wakeDisabled : false;
  return <div ref={stageRef} className={`orb-stage vector-face-orb phase-${phase}`} data-orb-pack={pack.id} data-orb-state={state}
    data-presence={standby ? 'standby' : waking ? 'waking' : asleep ? 'sleeping' : 'awake'}>
    <span ref={haloRef} className="vector-face-halo" aria-hidden="true" />
    <div ref={surfaceRef} className="vector-face-surface" aria-hidden="true"><svg ref={svgRef} viewBox="0 0 100 100" focusable="false" /></div>
    {props.children}
    {action && <button type="button" className="orb-wake-button vector-face-button" disabled={disabled}
      aria-label={standby ? 'Resume conversation' : onStandby ? 'Enter standby mode' : `Wake ${agentName}`}
      aria-pressed={onStandby || standby ? standby : undefined} onClick={action} />}
    {action && !disabled && <span className="vector-face-hint" aria-hidden="true">{standby ? 'Tap to resume' : onStandby ? 'Tap for standby' : asleep ? 'Tap to wake' : ''}</span>}
  </div>;
}
