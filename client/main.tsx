import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import LandingIntro from './LandingIntro';
import { OrbProvider } from './orbs/OrbProvider';
import './style.css';
import './messenger.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><OrbProvider><LandingIntro><App /></LandingIntro></OrbProvider></React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
