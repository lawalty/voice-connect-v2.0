import { lazy, Suspense } from 'react';
import ClassicOrb, { type OrbProps } from './orbs/ClassicOrb';
import { useOrbAppearance } from './orbs/OrbProvider';
import type { MouthPose } from './orbs/speech';
import './orbs/orbs.css';

const FaceOrb = lazy(() => import('./orbs/FaceOrb'));
export default function Orb(props: OrbProps & { getSpeech?: () => MouthPose }) {
  const { pack, preferences } = useOrbAppearance();
  return pack ? <Suspense fallback={<ClassicOrb {...props} />}><FaceOrb key={pack.id} {...props} pack={pack} motion={preferences.motion}/></Suspense> : <ClassicOrb {...props}/>;
}
