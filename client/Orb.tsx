import { lazy, Suspense } from 'react';
import ClassicOrb, { type OrbProps } from './orbs/ClassicOrb';
import { useOrbAppearance } from './orbs/OrbProvider';
import type { MouthPose } from './orbs/speech';
import EarMeters from './orbs/EarMeters';
import './orbs/orbs.css';

const FaceOrb = lazy(() => import('./orbs/FaceOrb'));
export default function Orb({ audioVuMeters = true, getMicrophoneLevel, ...props }: OrbProps & { getSpeech?: () => MouthPose; audioVuMeters?: boolean; getMicrophoneLevel?: () => number }) {
  const { pack, preferences } = useOrbAppearance();
  const ears = audioVuMeters ? <EarMeters getLevel={getMicrophoneLevel} /> : null;
  return pack ? <Suspense fallback={<ClassicOrb {...props}>{ears}</ClassicOrb>}><FaceOrb key={pack.id} {...props} pack={pack} motion={preferences.motion} phaseColors={preferences.phaseColors}>{ears}</FaceOrb></Suspense> : <ClassicOrb {...props}>{ears}</ClassicOrb>;
}
