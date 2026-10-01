import { createContext, useContext, useEffect, useState } from 'react';
import type { AgentIdentity } from '../contract/types';
import { api } from './api';

export const AgentNameContext = createContext('Assistant');
export const useAgentName = () => useContext(AgentNameContext);

/** Presentation metadata refreshes independently of voice, history, and drafts. */
export function useConversationAgentName(conversationId: string, authenticated: boolean, connected: boolean) {
  const [current, setCurrent] = useState<{ conversationId: string; name: string }>();
  useEffect(() => {
    if (!authenticated || !conversationId) return;
    let alive = true, pending = false;
    const abort = new AbortController();
    const refresh = async () => {
      if (pending || document.hidden || !navigator.onLine) return;
      pending = true;
      try {
        const agent = await api<AgentIdentity>(`/api/conversations/${encodeURIComponent(conversationId)}/agent`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
        if (alive && typeof agent.name === 'string' && agent.name.trim()) {
          setCurrent(previous => previous?.conversationId === conversationId && previous.name === agent.name ? previous : { conversationId, name: agent.name });
        }
      } catch { /* Keep the last known name through a temporary disconnect. */ }
      finally { pending = false; }
    };
    const foreground = () => { void refresh(); };
    const timer = setInterval(foreground, 30000);
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    window.addEventListener('pageshow', foreground);
    document.addEventListener('visibilitychange', foreground);
    void refresh();
    return () => {
      alive = false; abort.abort(); clearInterval(timer);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('online', foreground);
      window.removeEventListener('pageshow', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [conversationId, authenticated, connected]);
  return current?.conversationId === conversationId ? current.name : 'Assistant';
}
