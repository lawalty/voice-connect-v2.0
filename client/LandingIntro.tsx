import { useEffect, useState, type ReactNode } from 'react';

/** One welcome per page load, independent of authentication or conversation changes. */
export default function LandingIntro({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Also unmount when reduced motion disables CSS animation.
    const timer = window.setTimeout(() => setVisible(false), 1800);
    return () => window.clearTimeout(timer);
  }, []);
  return <>
    <div className="landing-content" inert={visible}>{children}</div>
    {visible && <div className="landing-intro">
      <h1>A place to<br /><em>think out loud.</em></h1>
    </div>}
  </>;
}
