import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import LandingIntro from './LandingIntro';
import './style.css';
import './messenger.css';
const CloudDesktop=React.lazy(()=>import('./CloudDesktop'));

createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname==='/desktop'?<React.Suspense fallback={<p role="status">Opening cloud desktop…</p>}><CloudDesktop/></React.Suspense>:<LandingIntro><App /></LandingIntro>}</React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
