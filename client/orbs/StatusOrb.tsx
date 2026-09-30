import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Mic } from 'lucide-react';
import { useAgentName } from '../agent-name';
import type { OrbProps } from './ClassicOrb';
import type { StatusPack } from './packs';
import { STATUS_METER_COLORS, statusMeterSegments, statusOrbState } from './status';
import './status-orb.css';

const SILENT = () => 0;
export interface StatusOrbProps extends OrbProps {
  pack: StatusPack; audioVuMeters?: boolean; getMicrophoneLevel?: () => number;
  /** Optional independent channels; the current capture engine supplies mono. */
  getLevels?: () => readonly [number, number];
}

function Meters({ active, getLevel, getLevels }: { active: boolean; getLevel: () => number; getLevels?: StatusOrbProps['getLevels'] }) {
  const latest = useRef({ active, getLevel, getLevels }); latest.current = { active, getLevel, getLevels };
  const [bars, setBars] = useState<readonly [number, number]>([0, 0]);
  useEffect(() => {
    let frame = 0, last = 0;
    let envelope = [0, 0];
    const draw = (time: number) => {
      frame = 0; if (document.hidden) return;
      if (!last || time - last >= 32) {
        const elapsed = last ? Math.min(100, time - last) : 32; last = time;
        const { active, getLevel, getLevels } = latest.current;
        const mono = active && !getLevels ? getLevel() : 0;
        const levels = active ? getLevels?.() ?? [mono, mono] : [0, 0];
        envelope = levels.map((value, i) => active ? Math.max(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0, envelope[i]! * Math.exp(-elapsed / 140)) : 0);
        const next = envelope.map(statusMeterSegments) as [number, number];
        setBars(previous => previous[0] === next[0] && previous[1] === next[1] ? previous : next);
      }
      frame = requestAnimationFrame(draw);
    };
    const visibility = () => { cancelAnimationFrame(frame); last = 0; envelope = [0, 0]; setBars([0, 0]); if (!document.hidden) frame = requestAnimationFrame(draw); };
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  return <div className="status-orb-ears" aria-hidden="true">{(['left', 'right'] as const).map((side, channel) =>
    <div key={side} className={`status-orb-ear status-orb-ear-${side}`} data-lit-segments={bars[channel]}>
      {STATUS_METER_COLORS.map((color, i) => <span key={i} className={i < bars[channel]! ? 'is-lit' : ''} style={{ '--segment-color': color } as CSSProperties} />)}
    </div>)}</div>;
}

export default function StatusOrb({ pack, phase, asleep = false, waking = false, onWake, wakeDisabled = false, onStandby, onResume, audioVuMeters = true, getMicrophoneLevel = SILENT, getLevels }: StatusOrbProps) {
  const agentName = useAgentName();
  const state = statusOrbState(phase, asleep, waking), standby = phase === 'standby';
  const action = standby ? onResume : onStandby || onWake;
  const disabled = standby || !onStandby ? wakeDisabled : false;
  const style = { '--status-color': pack.colors[state], '--status-halo': pack.colors[state === 'standby' ? 'listening' : state] } as CSSProperties;
  const glyph = <span className="status-orb-glyph"><Mic aria-hidden="true" /></span>;
  return <div className={`orb-stage status-orb phase-${phase}`} data-orb-state={state} data-presence={standby ? 'standby' : waking ? 'waking' : asleep ? 'sleeping' : 'awake'} style={style}>
    <span className="status-orb-halo" aria-hidden="true" />
    {action ? <button type="button" className="status-orb-body" disabled={disabled} aria-label={standby ? 'Resume conversation' : onStandby ? 'Enter standby mode' : `Wake ${agentName}`} aria-pressed={onStandby || standby ? standby : undefined} onClick={action}>{glyph}</button>
      : <div className="status-orb-body" aria-hidden="true">{glyph}</div>}
    {audioVuMeters && <Meters active={state === 'listening' || state === 'thinking' || state === 'speaking'} getLevel={getMicrophoneLevel} getLevels={getLevels} />}
    {action && !disabled && <span className="status-orb-hint" aria-hidden="true">{standby ? 'Tap to resume' : onStandby ? 'Tap for standby' : asleep ? 'Tap to wake' : ''}</span>}
  </div>;
}
