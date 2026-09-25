import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, AudioLines, Camera as CameraIcon, Check, ChevronDown, CircleStop, Headphones, LockKeyhole, MessageSquare, Mic, MicOff, Plus, Send, Settings2, Square, WifiOff, X } from 'lucide-react';
import { type AcousticSignal, type AppSettings, type AppStatus, type Attachment, type Conversation, type ConversationView, type Message, type ServerEvent, type SpeechPreferences, type TurnReceipt, type VoicePhase } from '../contract/types';
import { api, setCsrf } from './api';
import { VoiceEngine } from './audio/engine';
import Orb from './Orb';
import Settings from './Settings';
import Camera from './Camera';
import Dialog from './Dialog';
import VoiceSetup from './VoiceSetup';
import { modelStatus } from './audio/model';
import { restoreSpeechPreferences } from './speech-preferences';

const preferenceKey = 'vc2:speech';
const labels: Partial<Record<VoicePhase, string>> = { starting: 'Opening your microphone', listening: 'Listening to you', hearing: 'I’m hearing you', finalizing: 'Finishing your thought', thinking: 'NorthPointe is thinking', speaking: 'NorthPointe is speaking', paused: 'Your microphone is muted', error: 'Voice needs attention' };
const hints: Partial<Record<VoicePhase, string>> = { starting: 'Allow microphone access if your browser asks.', listening: 'Take your time. There’s room to think.', hearing: 'Your words are becoming one complete thought.', finalizing: 'Collecting the complete transcript.', thinking: 'Your message has reached the conversation.', speaking: 'You can interrupt whenever you need.', paused: 'Typing is still available.', error: 'You can keep the conversation going by typing.' };
function readPreferences(): SpeechPreferences { try { return restoreSpeechPreferences(localStorage.getItem(preferenceKey)); } catch { return restoreSpeechPreferences(null); } }
function messageFor(error: unknown) { return error instanceof Error ? error.message : 'Something interrupted the request. Please try again.'; }
function Brand() { return <a className="brand" href="/" aria-label="Voice Connect home"><span className="brand-mark"><AudioLines size={22} strokeWidth={1.5} /></span><span>voice<span className="brand-light">connect</span><span className="version">2.0</span></span></a>; }

function Entry({ status, onAuthenticated, initialError }: { status: AppStatus; onAuthenticated: (status: AppStatus) => void; initialError: string }) {
  const [password, setPassword] = useState(''), [token, setToken] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const setup = status && !status.ownerConfigured;
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const next = await api<AppStatus>(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ password, ...(setup ? { bootstrapToken: token } : {}) }) }); setPassword(''); setToken(''); onAuthenticated(next); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); } }
  return <div className="entry-page"><header className="site-header"><Brand /></header><main className="entry-main"><section className="entry-card"><h2>{setup ? 'Set up your password' : 'Sign in'}</h2><p className="muted">{setup ? 'Create the owner password to begin your private conversation.' : 'Sign in to pick up the conversation.'}</p><form onSubmit={event => void submit(event)}>{setup && <label>Setup token<input value={token} onChange={event => setToken(event.target.value)} type="password" required autoComplete="off" placeholder="From your server setup" /></label>}<label>{setup ? 'Create password' : 'Password'}<input value={password} onChange={event => setPassword(event.target.value)} type="password" required minLength={setup ? 12 : undefined} autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? 'At least 12 characters' : 'Your private password'} /></label><button type="submit" className="button primary full-width" disabled={busy}>{busy ? 'Connecting…' : setup ? 'Create my space' : 'Enter your space'}<ArrowRight size={17} /></button></form>{(error || initialError) && <p className="error-text" role="alert">{error || initialError}</p>}</section></main></div>;
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null), [initialError, setInitialError] = useState('');
  const [settings, setSettings] = useState<AppSettings | null>(null), [conversations, setConversations] = useState<Conversation[]>([]), [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]), [draft, setDraft] = useState(''), [heard, setHeard] = useState(''), [attachment, setAttachment] = useState<Attachment | null>(null);
  const [phase, setPhase] = useState<VoicePhase>('off'), [signal, setSignal] = useState<AcousticSignal | null>(null), [preferences, setPreferences] = useState(readPreferences);
  const [voiceActive, setVoiceActive] = useState(false), [muted, setMuted] = useState(false), [online, setOnline] = useState(navigator.onLine), [connected, setConnected] = useState(false), [sending, setSending] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState('');
  const [creatingConversation, setCreatingConversation] = useState(false), [preparingVoice, setPreparingVoice] = useState(false);
  const [notice, setNotice] = useState(() => {
    try { if (JSON.parse(localStorage.getItem(preferenceKey) || '{}')?.output === 'deepgram') return 'Deepgram is now for speech recognition only. Playback uses device voices; you can select Fish Audio in Settings.'; } catch {}
    return '';
  }), [activity, setActivity] = useState(''), [activeTurn, setActiveTurn] = useState<TurnReceipt | null>(null);
  const [modal, setModal] = useState<'settings' | 'camera' | 'conversations' | 'voice-setup' | null>(null), [showTranscript, setShowTranscript] = useState(false);
  const [voiceSetupPreferences, setVoiceSetupPreferences] = useState<SpeechPreferences | null>(null);
  const [approval, setApproval] = useState<Extract<ServerEvent, { type: 'approval' }> | null>(null), [question, setQuestion] = useState<Extract<ServerEvent, { type: 'question' }> | null>(null), [answer, setAnswer] = useState('');
  const [approvalHidden, setApprovalHidden] = useState(false), [questionHidden, setQuestionHidden] = useState(false);
  const engine = useRef<VoiceEngine | null>(null), activeTurnRef = useRef<TurnReceipt | null>(null), conversationRef = useRef(''), voiceRef = useRef(false), textarea = useRef<HTMLTextAreaElement>(null), transcriptEnd = useRef<HTMLDivElement>(null);
  const submitRef = useRef<(text: string) => Promise<void>>(async () => {}), abortRef = useRef<() => Promise<void>>(async () => {});
  const heardRef = useRef(''), draftRevision = useRef(0);
  const voiceStart = useRef<symbol | null>(null);
  const cancelVoiceStart = useCallback(() => { voiceStart.current = null; setPreparingVoice(false); }, []);
  const spoken = useRef(new Map<string, string>()), sequences = useRef(new Map<string, number>()), latest = useRef({ preferences, attachment, draft }); latest.current = { preferences, attachment, draft };
  const completed = useRef(new Set<string>()), cancelled = useRef(new Set<string>()), speakingTurn = useRef(''), sendingRef = useRef(false), aborting = useRef<Promise<void> | null>(null), suppressAbort = useRef(false);
  const pendingVoiceTurn = useRef('');
  activeTurnRef.current = activeTurn; conversationRef.current = conversationId; voiceRef.current = voiceActive;

  const updateDraft = useCallback((next: string | ((current: string) => string)) => {
    const value = typeof next === 'function' ? next(latest.current.draft) : next;
    if (value !== latest.current.draft) ++draftRevision.current;
    latest.current.draft = value; setDraft(value);
  }, []);
  const updateHeard = useCallback((text: string) => { heardRef.current = text; setHeard(text); }, []);
  const enterTextMode = useCallback((text = latest.current.draft) => {
    const unsent = heardRef.current.trim();
    const combined = unsent ? (text ? `${text}\n${unsent}` : unsent) : text;
    // Disarm synchronously: late recognition callbacks must not submit the old voice draft.
    cancelVoiceStart(); voiceRef.current = false;
    engine.current?.stop();
    suppressAbort.current = true; engine.current?.interrupt(); suppressAbort.current = false;
    setVoiceActive(false); setMuted(false); setPhase('off'); setSignal(null); updateHeard('');
    updateDraft(combined);
    return combined;
  }, [updateHeard, updateDraft, cancelVoiceStart]);

  const authenticate = useCallback((next: AppStatus) => { setCsrf(next.csrfToken); setStatus(next); }, []);
  const selectConversation = useCallback((id: string) => {
    let restored = ''; try { restored = localStorage.getItem(`vc2:draft:${id}`) || ''; localStorage.setItem('vc2:conversation', id); } catch {}
    // Restore before exposing the new composer; a delayed effect must never erase freshly typed input.
    updateDraft(restored); setConversationId(id); conversationRef.current = id;
  }, [updateDraft]);
  const refreshSettings = useCallback(async () => { setSettings(await api<AppSettings>('/api/settings')); }, []);
  const refreshHistory = useCallback(async (id: string, baseline = false) => {
    const view = await api<ConversationView>(`/api/conversations/${encodeURIComponent(id)}`);
    if (conversationRef.current !== id) return;
    setMessages(view.messages); setActiveTurn(view.activeTurn || null);
    if (baseline) for (const message of view.messages) if (message.role === 'assistant' && message.turnId) {
      // Background reconciliation must not consume speech that the active voice
      // turn has not played. Initial/reconnected history still stays silent.
      const liveVoiceTurn = voiceRef.current && !completed.current.has(message.turnId) && !cancelled.current.has(message.turnId)
        && (message.turnId === pendingVoiceTurn.current || message.turnId === activeTurnRef.current?.turnId || message.turnId === speakingTurn.current);
      if (!liveVoiceTurn) spoken.current.set(message.turnId, message.text);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void api<AppStatus>('/api/status').then(value => { if (current) authenticate(value); }).catch(reason => { if (current) setInitialError(messageFor(reason)); });
    return () => { current = false; };
  }, [authenticate]);
  useEffect(() => {
    const up = () => setOnline(true), down = () => { setOnline(false); setConnected(false); };
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(() => {
    const expired = () => { cancelVoiceStart(); voiceRef.current = false; suppressAbort.current = true; engine.current?.interrupt(); engine.current?.stop(); suppressAbort.current = false; setVoiceActive(false); setPhase('off'); setStatus(value => value ? { ...value, authenticated: false, csrfToken: undefined } : value); setCsrf(); setInitialError('Your session ended. Sign in again to continue.'); };
    window.addEventListener('vc-auth-expired', expired);
    return () => window.removeEventListener('vc-auth-expired', expired);
  }, [cancelVoiceStart]);
  useEffect(() => {
    if (!status?.authenticated) return;
    let valid = true, loading = false, loaded = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!valid || loading || loaded || !navigator.onLine) return;
      clearTimeout(timer); loading = true;
      try {
        const [nextSettings, list] = await Promise.all([api<AppSettings>('/api/settings'), api<Conversation[]>('/api/conversations')]);
        if (!valid) return;
        let selected = ''; try { selected = localStorage.getItem('vc2:conversation') || ''; } catch {}
        const existing = list.find(item => item.id === selected) || list[0];
        // Re-read the list before creating: an earlier request may have reached the server.
        const current = existing || await api<Conversation>('/api/conversations', { method: 'POST', body: '{}' });
        if (!valid) return;
        loaded = true; setSettings(nextSettings); setConversations(existing ? list : [current]);
        setConnectionIssue(''); selectConversation(current.id);
      } catch {
        if (!valid) return;
        setConnectionIssue('Unable to load your conversation. Retrying…');
        timer = setTimeout(() => void load(), 4000);
      } finally { loading = false; }
    }
    const retry = () => { void load(); };
    window.addEventListener('online', retry); void load();
    return () => { valid = false; clearTimeout(timer); window.removeEventListener('online', retry); };
  }, [status?.authenticated, selectConversation]);

  useEffect(() => {
    const instance = new VoiceEngine({
      onPhase: setPhase, onDraft: text => { if (voiceRef.current) updateHeard(text); },
      onTurn: text => { if (voiceRef.current) { updateHeard(''); void submitRef.current(text); } }, onSignal: setSignal,
      onError: error => { voiceRef.current = false; setVoiceActive(false); setNotice(typeof error === 'string' ? error : messageFor(error)); },
      onInterrupt: () => { if (!suppressAbort.current) void abortRef.current(); }, onNotice: setNotice,
    }); engine.current = instance;
    return () => { instance.dispose(); if (engine.current === instance) engine.current = null; };
  }, [updateHeard]);

  useEffect(() => {
    if (!conversationId || !status?.authenticated) return;
    let alive = true, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout>, retries = 0, connectionEpoch = 0;
    setMessages([]); updateHeard(''); setActiveTurn(null); setActivity(''); spoken.current.clear(); sequences.current.clear(); completed.current.clear(); cancelled.current.clear(); speakingTurn.current = ''; pendingVoiceTurn.current = '';
    function suspendVoice() {
      cancelVoiceStart();
      if (!voiceRef.current) return;
      voiceRef.current = false; suppressAbort.current = true;
      engine.current?.interrupt(); engine.current?.stop(); suppressAbort.current = false;
      setVoiceActive(false); setMuted(false); setPhase('off');
      setNotice('Voice paused during the connection loss. Your conversation is saved; tap the orb when connected.');
    }
    function disconnect() {
      ++connectionEpoch; clearTimeout(timer);
      const previous = socket; socket = null;
      if (previous) { previous.onclose = null; previous.onmessage = null; previous.onopen = null; previous.onerror = null; previous.close(); }
      setConnected(false);
    }
    function reconnect(reason = 'Connection interrupted. Retrying…') {
      disconnect(); suspendVoice(); setConnectionIssue(reason);
      timer = setTimeout(() => void connect(), Math.min(4000, 1000 * 2 ** Math.min(retries++, 2)));
    }
    const offline = () => { disconnect(); suspendVoice(); };
    const online = () => { if (!alive) return; disconnect(); retries = 0; void connect(); };
    async function connect() {
      if (!alive || !navigator.onLine) return;
      clearTimeout(timer);
      const epoch = ++connectionEpoch;
      try {
        await refreshHistory(conversationId, true); if (!alive || epoch !== connectionEpoch || !navigator.onLine) return;
        const currentSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events?conversationId=${encodeURIComponent(conversationId)}`);
        socket = currentSocket;
        // The socket opening alone does not confirm the conversation subscription.
        function confirmConnection() {
          retries = 0; setConnected(true); setConnectionIssue('');
          setNotice(value => {
            if (value.startsWith('Voice paused during the connection loss.')) return 'Connected again. Your conversation is restored; tap the orb to resume voice.';
            return value;
          });
        }
        socket.onmessage = message => {
          if (!alive || epoch !== connectionEpoch) return;
          let event: ServerEvent; try { event = JSON.parse(message.data); } catch { return; }
          if ('conversationId' in event && event.conversationId !== conversationId) return;
          if (event.type === 'hello') { setSettings(value => value ? { ...value, harness: event.capabilities } : value); confirmConnection(); }
          if (event.type === 'connection') { setSettings(value => value ? { ...value, harness: { ...value.harness, connected: event.connected, reason: event.connected ? undefined : event.reason } } : value); }
          if (event.type === 'turn') {
            setMessages(items => items.map(item => item.role === 'user' && item.turnId === event.turnId ? { ...item, delivery: event.delivery } : item));
            if (['accepted', 'pending'].includes(event.delivery)) setActiveTurn({ turnId: event.turnId, runId: event.runId, delivery: event.delivery });
            else if (activeTurnRef.current?.turnId === event.turnId) setActiveTurn(null);
            if (event.error) setNotice(event.error);
          }
          if (event.type === 'assistant') {
            const key = `${event.runId}:${event.turnId}`;
            if (event.seq <= (sequences.current.get(key) ?? -1)) return;
            sequences.current.set(key, event.seq);
            setMessages(items => {
              const existing = items.find(item => item.role === 'assistant' && item.turnId === event.turnId);
              const text = event.replace ? event.text : (existing?.text || '') + event.text;
              if (existing) return items.map(item => item.id === existing.id ? { ...item, text } : item);
              return [...items, { id: `assistant-${event.turnId}`, role: 'assistant', text, turnId: event.turnId, runId: event.runId, createdAt: Date.now() }];
            });
            const previous = spoken.current.get(event.turnId) || '';
            const full = event.replace ? event.text : previous + event.text;
            if (voiceRef.current && !cancelled.current.has(event.turnId) && !completed.current.has(event.turnId) && full.startsWith(previous)) { speakingTurn.current = event.turnId; engine.current?.speak(full.slice(previous.length), false); }
            spoken.current.set(event.turnId, full);
          }
          if (event.type === 'complete') {
            if (completed.current.has(event.turnId)) return;
            completed.current.add(event.turnId);
            if (pendingVoiceTurn.current === event.turnId) pendingVoiceTurn.current = '';
            if (event.cancelled || event.failed) {
              cancelled.current.add(event.turnId);
              if (activeTurnRef.current?.turnId === event.turnId || speakingTurn.current === event.turnId) { setActiveTurn(null); activeTurnRef.current = null; engine.current?.interrupt(); setActivity(''); }
              if (event.failed) setNotice('NorthPointe could not complete this turn. Your message is kept in the conversation.');
              return;
            }
            if (event.text) {
              setMessages(items => { const existing = items.find(item => item.role === 'assistant' && item.turnId === event.turnId); return existing ? items.map(item => item.id === existing.id ? { ...item, text: event.text! } : item) : [...items, { id: `assistant-${event.turnId}`, role: 'assistant', text: event.text!, turnId: event.turnId, createdAt: Date.now() }]; });
              const previous = spoken.current.get(event.turnId) || '';
              if (voiceRef.current && !event.cancelled && !cancelled.current.has(event.turnId) && event.text.startsWith(previous)) { speakingTurn.current = event.turnId; engine.current?.speak(event.text.slice(previous.length), false); }
              spoken.current.set(event.turnId, event.text);
            }
            if (voiceRef.current && !cancelled.current.has(event.turnId) && (speakingTurn.current === event.turnId || activeTurnRef.current?.turnId === event.turnId)) engine.current?.responseDone();
            if (activeTurnRef.current?.turnId === event.turnId) setActiveTurn(null); setActivity('');
          }
          if (event.type === 'activity') setActivity(event.label);
          if (event.type === 'approval') { setApproval(event); setApprovalHidden(false); }
          if (event.type === 'question') { setQuestion(event); setQuestionHidden(false); setAnswer(''); }
          if (event.type === 'error') setNotice(event.message);
          if (event.type === 'reconcile') void refreshHistory(conversationId, true).catch(() => {
            if (alive && epoch === connectionEpoch) reconnect('Unable to refresh your conversation. Retrying…');
          });
        };
        socket.onclose = () => {
          if (!alive || epoch !== connectionEpoch) return;
          reconnect();
        };
        socket.onerror = () => currentSocket.close();
      } catch { if (!alive || epoch !== connectionEpoch) return; reconnect('Unable to refresh your conversation. Retrying…'); }
    }
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    void connect();
    return () => { alive = false; window.removeEventListener('offline', offline); window.removeEventListener('online', online); disconnect(); };
  }, [conversationId, status?.authenticated, refreshHistory, updateHeard, cancelVoiceStart]);

  useEffect(() => { if (conversationId) { try { localStorage.setItem(`vc2:draft:${conversationId}`, draft); } catch {} } }, [draft, conversationId]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); }, [messages.length, messages.at(-1)?.text, showTranscript]);

  const abort = useCallback(async () => {
    if (aborting.current) return aborting.current;
    const current = activeTurnRef.current; if (!current || !conversationRef.current) return;
    cancelled.current.add(current.turnId);
    const operation = (async () => {
      try { await api(`/api/conversations/${encodeURIComponent(conversationRef.current)}/turns/${encodeURIComponent(current.turnId)}/abort`, { method: 'POST', body: '{}' }); setActiveTurn(null); activeTurnRef.current = null; setActivity(''); }
      catch (reason) { setNotice(`Audio stopped. ${messageFor(reason)}`); throw reason; }
      finally { aborting.current = null; }
    })();
    aborting.current = operation; return operation;
  }, []);
  abortRef.current = async () => { try { await abort(); } catch {} };
  const submit = useCallback(async (text: string, source: 'voice' | 'text' = 'text') => {
    const trimmed = (source === 'text' ? enterTextMode(text) : text).trim(), id = conversationRef.current, photo = latest.current.attachment;
    if ((!trimmed && !photo) || !id) return;
    if (sendingRef.current) {
      if (source === 'voice' && trimmed) {
        updateHeard(trimmed); enterTextMode();
        setNotice('Your next thought is kept in the composer while the earlier delivery is pending. Voice is paused; review and send when ready.');
      }
      return;
    }
    if (!navigator.onLine) { updateDraft(trimmed); setNotice('You’re offline. Your words are kept in the composer.'); return; }
    sendingRef.current = true; setSending(true); setNotice('');
    const turnId = crypto.randomUUID(), submittedRevision = draftRevision.current;
    // Delivery can become terminal before the response stream reaches this tab.
    // Keep speech ownership independent of the server's active-run status.
    if (source === 'voice' && voiceRef.current) pendingVoiceTurn.current = turnId;
    const restoreSubmittedDraft = () => {
      if (conversationRef.current !== id) return;
      if (source === 'voice') updateDraft(value => value.includes(trimmed) ? value : value ? `${value}\n${trimmed}` : trimmed);
      else if (draftRevision.current === submittedRevision) updateDraft(trimmed);
    };
    try {
      if (activeTurnRef.current) { engine.current?.interrupt(); await abort(); }
      const receipt = await api<TurnReceipt>(`/api/conversations/${encodeURIComponent(id)}/turns`, { method: 'POST', body: JSON.stringify({ id: turnId, text: trimmed, ...(photo ? { attachments: [photo.id] } : {}) }) });
      if (conversationRef.current !== id) return;
      setMessages(items => items.some(item => item.turnId === receipt.turnId && item.role === 'user') ? items : [...items, { id: turnId, role: 'user', text: trimmed, createdAt: Date.now(), turnId: receipt.turnId, delivery: receipt.delivery, attachments: photo ? [photo] : undefined }]);
      if (!completed.current.has(receipt.turnId) && ['pending', 'accepted', 'uncertain'].includes(receipt.delivery)) { setActiveTurn(receipt); activeTurnRef.current = receipt; if (voiceRef.current && speakingTurn.current !== receipt.turnId) setPhase('thinking'); }
      if (receipt.delivery === 'failed' || receipt.delivery === 'cancelled' || receipt.delivery === 'uncertain') {
        restoreSubmittedDraft();
        setNotice(receipt.delivery === 'uncertain' ? 'Delivery is uncertain. Your draft is kept; check the conversation before sending again.' : `This turn was ${receipt.delivery}. Your draft is kept.`);
      } else {
        if (source === 'text' && draftRevision.current === submittedRevision) updateDraft('');
        if (latest.current.attachment?.id === photo?.id) setAttachment(null);
      }
      void api<Conversation[]>('/api/conversations').then(setConversations).catch(() => {});
    } catch (reason) { restoreSubmittedDraft(); setNotice(`${messageFor(reason)} Your draft is kept. Check the conversation before resending if delivery is uncertain.`); void refreshHistory(id, true).catch(() => {}); }
    finally { sendingRef.current = false; setSending(false); }
  }, [abort, refreshHistory, enterTextMode, updateDraft, updateHeard]); submitRef.current = text => submit(text, 'voice');

  function savePreferences(value: SpeechPreferences) { setPreferences(value); try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch {} }
  async function startVoice(nextPreferences = preferences) {
    if (!conversationId || !engine.current || voiceStart.current) return;
    const request = Symbol('wake'); voiceStart.current = request; setPreparingVoice(true);
    try {
      if (nextPreferences.recognition === 'vosk') {
        let installed = false;
        try { installed = (await modelStatus()).installed; } catch {}
        if (voiceStart.current !== request) return;
        if (!installed) { setVoiceSetupPreferences(nextPreferences); setModal('voice-setup'); return; }
      }
      if (heard.trim()) updateDraft(value => value ? `${value}\n${heard.trim()}` : heard.trim());
      setNotice(''); voiceRef.current = true; setVoiceActive(true); setMuted(false);
      // Start audio from this gesture; the orb animation never gates microphone startup.
      await engine.current.start(nextPreferences, conversationId);
    } catch (reason) {
      if (voiceStart.current !== request) return;
      voiceRef.current = false; setVoiceActive(false); setPhase('error'); setNotice(messageFor(reason));
    } finally {
      if (voiceStart.current === request) { voiceStart.current = null; setPreparingVoice(false); }
    }
  }
  function endVoice() { cancelVoiceStart(); voiceRef.current = false; engine.current?.interrupt('manual', false); engine.current?.stop(); setVoiceActive(false); setMuted(false); setPhase('off'); updateHeard(''); setSignal(null); }
  function interrupt() { if (activeTurnRef.current) cancelled.current.add(activeTurnRef.current.turnId); engine.current?.interrupt(); void abortRef.current(); }
  async function newConversation() {
    if (creatingConversation) return;
    setCreatingConversation(true);
    try { endVoice(); const created = await api<Conversation>('/api/conversations', { method: 'POST', body: '{}' }); setConversations(items => [created, ...items]); selectConversation(created.id); setModal(null); setAttachment(null); }
    catch (reason) { setNotice(messageFor(reason)); }
    finally { setCreatingConversation(false); }
  }
  async function logout() { endVoice(); try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); setStatus(current => current ? { ...current, authenticated: false, csrfToken: undefined } : current); setCsrf(); setModal(null); setMessages([]); setConversationId(''); } catch (reason) { setNotice(messageFor(reason)); } }
  async function resolveApproval(decision: 'allow-once' | 'deny') { if (!approval) return; try { await api(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: JSON.stringify({ decision }) }); setApproval(null); } catch (reason) { setNotice(messageFor(reason)); } }
  async function answerQuestion(value: string) { if (!question || !value.trim()) return; try { await api(`/api/questions/${encodeURIComponent(question.id)}`, { method: 'POST', body: JSON.stringify({ answer: value.trim() }) }); setQuestion(null); setAnswer(''); } catch (reason) { setNotice(messageFor(reason)); } }

  if (!status) return <div className="entry-page"><header className="site-header"><Brand /></header><main className="startup-state">{initialError ? <><p className="error-text" role="alert">{initialError}</p><button className="button secondary" onClick={() => window.location.reload()}>Retry connection</button></> : <p role="status">Connecting…</p>}</main></div>;
  if (!status.authenticated) return <Entry status={status} onAuthenticated={authenticate} initialError={initialError} />;
  const harnessConnected = settings?.harness.connected ?? false;
  const fullyConnected = online && connected && harnessConnected && !connectionIssue;
  const connectionLabel = !online ? 'Offline' : fullyConnected ? 'Connected' : connectionIssue || settings?.harness.reason ? 'Reconnecting' : 'Connecting';
  const connectionDetail = !online ? 'Your draft is kept on this device.' : fullyConnected ? undefined : connectionIssue || settings?.harness.reason || 'Connecting to NorthPointe…';
  const displayPhase: VoicePhase = !online || !connected || !harnessConnected ? 'reconnecting' : phase === 'off' && activeTurn !== null ? 'thinking' : phase;
  const busy = activeTurn !== null;
  const automaticTurns = preferences.recognition !== 'browser' && preferences.handsFree;
  const currentConversation = conversations.find(item => item.id === conversationId);
  const orbAsleep = !voiceActive && !busy && !preparingVoice;
  const wakeDisabled = preparingVoice || creatingConversation || !conversationId || !online || !connected || !harnessConnected;
  return <div className="app-shell"><header className="site-header"><Brand /><div className="header-center"><LockKeyhole size={11} />PRIVATE CONVERSATION</div><div className="header-actions"><span className={`connection-pill ${fullyConnected ? 'is-connected' : ''}`} role="status" aria-live="polite" title={connectionDetail}><span className="status-dot" />{connectionLabel}</span><button className="icon-button" onClick={() => { enterTextMode(); setModal('settings'); }} aria-label="Open settings" disabled={!settings}><Settings2 size={20} /></button></div></header><main className="workspace"><section className="voice-space" aria-label="Voice conversation"><div className="conversation-heading"><button className="conversation-title" onClick={() => setModal('conversations')}><span>NorthPointe</span><ChevronDown size={16} /></button></div><div className="voice-center"><Orb phase={displayPhase} signal={signal} asleep={orbAsleep} waking={preparingVoice || phase === 'starting'} onWake={!voiceActive ? () => void startVoice() : undefined} wakeDisabled={wakeDisabled} /><div className="voice-state" role="status" aria-live="polite">{labels[displayPhase] && <><div className={`state-label state-${displayPhase}`}><span className="state-light" />{labels[displayPhase]}</div><p>{activity || hints[displayPhase]}</p></>}</div>{!orbAsleep && <div className="acoustic-caption"><span className="acoustic-line" /><span>{signal && voiceActive ? 'RESPONDING TO YOUR SOUND' : 'A LITTLE ROOM TO BREATHE'}</span><span className="acoustic-line" /></div>}</div><div className="voice-bottom">{heard && <div className="heard-draft"><span>HEARING</span><p>{heard}</p><small>Not sent yet</small><button className="text-button edit-heard" onClick={() => { enterTextMode(); textarea.current?.focus(); }}>Edit as text</button></div>}{(voiceActive || preparingVoice || busy || phase === 'speaking') && <div className="voice-controls">{preparingVoice && !voiceActive && <button className="control-button end-button" onClick={endVoice}><Square size={17} /><span>Cancel wake</span></button>}{voiceActive && <><button className={`control-button ${muted ? 'is-active' : ''}`} onClick={() => { engine.current?.mute(!muted); setMuted(!muted); }} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted}>{muted ? <MicOff size={20} /> : <Mic size={20} />}<span>{muted ? 'Unmute' : 'Mute'}</span></button>{!automaticTurns && <button className="button finish-button" onClick={() => void engine.current?.finish()} disabled={muted || ['starting', 'finalizing', 'thinking', 'speaking'].includes(phase)}><Check size={19} />Finish thought</button>}{(phase === 'paused' || phase === 'error') && <button className="control-button" onClick={() => void startVoice()}><Mic size={18} /><span>Record again</span></button>}<button className="control-button end-button" onClick={endVoice} aria-label="End voice session"><Square size={17} fill="currentColor" /><span>End voice</span></button></>}{(busy || phase === 'speaking') && <button className="control-button interrupt-button" onClick={interrupt}><CircleStop size={20} /><span>Interrupt</span></button>}</div>}{!voiceActive && preferences.recognition === 'browser' && <button className="text-button continuous-voice-link" onClick={() => { setVoiceSetupPreferences({ ...preferences, recognition: 'vosk', handsFree: true, turnMode: 'automatic' }); setModal('voice-setup'); }}>Set up continuous voice</button>}{!voiceActive && preferences.recognition !== 'browser' && !preferences.handsFree && <button className="text-button continuous-voice-link" onClick={() => { savePreferences({ ...preferences, handsFree: true, turnMode: 'automatic' }); setNotice('Automatic turns selected. Start talking once to begin; pauses will send each thought.'); }}>Use automatic turns</button>}</div><button className="mobile-transcript-toggle" onClick={() => setShowTranscript(true)}><MessageSquare size={17} />Conversation<span>{messages.length}</span></button></section><aside className={`conversation-panel ${showTranscript ? 'mobile-open' : ''}`} aria-label="Conversation transcript"><header className="panel-header"><div><span className="eyebrow">THE CONVERSATION</span><h2>All your thoughts, together.</h2></div><button className="icon-button desktop-new" aria-label="Start a new conversation" onClick={() => void newConversation()}><Plus size={19} /></button><button className="icon-button mobile-close" aria-label="Close transcript" onClick={() => setShowTranscript(false)}><ChevronDown size={22} /></button></header><div className="transcript" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text">{messages.length === 0 ? <div className="empty-conversation"><span className="empty-icon"><MessageSquare size={26} strokeWidth={1.25} /></span><h3>A thought starts here.</h3><p>Speak, type, or share what you’re seeing.<br />It all belongs to the same conversation.</p><span className="empty-rule" /></div> : messages.map(message => <article className={`message message-${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === 'user' ? 'YOU' : 'NORTHPOINTE'}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>{message.attachments?.map(photo => photo.previewUrl && <img className="message-photo" key={photo.id} src={photo.previewUrl} alt={photo.name || 'Shared photo'} />)}<p>{message.text}</p>{message.role === 'user' && message.delivery && ['pending', 'uncertain', 'failed', 'cancelled'].includes(message.delivery) && <span className="delivery-status">{message.delivery === 'uncertain' ? 'Delivery uncertain · check before resending' : message.delivery}</span>}</article>)}{activity && <div className="activity"><span className="activity-pulse" />{activity}</div>}<div ref={transcriptEnd} /></div><div className="panel-footnote"><LockKeyhole size={11} />{currentConversation?.title && currentConversation.title !== 'New conversation' ? currentConversation.title : 'Your voice and text share one thread'}</div></aside></main>{notice && <div className="notice" role="status"><span>{!online && <WifiOff size={15} />}{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={16} /></button></div>}{((approval && approvalHidden) || (question && questionHidden)) && <div className="pending-action">{approval && approvalHidden && <button className="button secondary small" onClick={() => setApprovalHidden(false)}>Review pending approval</button>}{question && questionHidden && <button className="button secondary small" onClick={() => setQuestionHidden(false)}>Answer pending question</button>}</div>}<footer className="composer-area"><form className="composer" onSubmit={event => { event.preventDefault(); void submit(draft); }}>{attachment && <div className="attachment-chip">{attachment.previewUrl && <img src={attachment.previewUrl} alt="Photo attached to draft" />}<span>Photo attached</span><button type="button" className="icon-button" onClick={() => setAttachment(null)} aria-label="Remove attached photo"><X size={14} /></button></div>}<button type="button" className="composer-camera icon-button" onClick={() => setModal('camera')} disabled={!conversationId || !settings?.harness.images || !online} aria-label="Attach a camera photo" title={settings?.harness.images ? 'Share a photo' : 'Image input is unavailable for this connection'}><CameraIcon size={20} /></button><textarea ref={textarea} aria-label="Message NorthPointe" rows={1} disabled={creatingConversation || !conversationId} placeholder="Or put it into words…" value={draft} onFocus={() => { enterTextMode(); }} onChange={event => { updateDraft(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(draft); } }} /><button type="submit" className="send-button" aria-label="Send message" disabled={!conversationId || creatingConversation || sending || (!draft.trim() && !attachment) || !online || !connected || !harnessConnected}>{sending ? <span className="loading-dot" /> : <ArrowRight size={22} />}</button></form><div className="composer-caption"><span>VOICE + TEXT, ONE CONVERSATION</span><span className="desktop-only">ENTER TO SEND · SHIFT + ENTER FOR A NEW LINE</span></div></footer>{modal === 'settings' && settings && <Settings settings={settings} conversationId={conversationId} preferences={preferences} build={status.build} getAudioDiagnostics={() => engine.current?.diagnostics() || []} onSave={value => { if (voiceActive) endVoice(); savePreferences(value); setNotice('Preferences saved. Your next voice session will use them.'); }} onRefresh={refreshSettings} onClose={() => setModal(null)} onLogout={() => void logout()} onBeforeModelRemove={() => { if (heard.trim()) updateDraft(value => value ? value + "\n" + heard.trim() : heard.trim()); endVoice(); }} />}{modal === 'voice-setup' && <VoiceSetup automatic={(voiceSetupPreferences || preferences).handsFree} onClose={() => setModal(null)} onStart={() => { const next = voiceSetupPreferences || preferences; savePreferences(next); setModal(null); void startVoice(next); }} onFallback={() => { savePreferences({ ...preferences, recognition: 'browser', handsFree: false }); setModal(null); setNotice('Browser tap-to-talk selected. Start talking, then use Finish to send each thought.'); }} />}{modal === 'camera' && <Camera onClose={() => setModal(null)} onAttach={setAttachment} />}{modal === 'conversations' && <Dialog title="Your conversations" onClose={() => setModal(null)}><button className="button primary full-width" onClick={() => void newConversation()}><Plus size={17} />Begin a new conversation</button><div className="conversation-list">{conversations.map(conversation => <button key={conversation.id} className={conversation.id === conversationId ? 'selected' : ''} onClick={() => { if (conversation.id !== conversationId) { endVoice(); selectConversation(conversation.id); setAttachment(null); } setModal(null); }}><MessageSquare size={18} /><span><strong>{conversation.title || 'Untitled conversation'}</strong><small>{new Date(conversation.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small></span>{conversation.id === conversationId && <Check size={16} />}</button>)}</div></Dialog>}{approval && !approvalHidden && <Dialog title="NorthPointe needs your approval" onClose={() => setApprovalHidden(true)}><p className="approval-copy">{approval.label}</p>{approval.detail ? <pre className="approval-detail">{approval.detail}</pre> : <p className="error-text">The exact action was not supplied. Review it in OpenClaw before granting approval.</p>}{approval.expiresAt && <p className="muted">Expires {new Date(approval.expiresAt).toLocaleTimeString()}</p>}<div className="dialog-actions"><button className="button secondary" onClick={() => void resolveApproval('deny')}>Deny</button><button className="button primary" disabled={!approval.detail || Boolean(approval.expiresAt && approval.expiresAt < Date.now())} onClick={() => void resolveApproval('allow-once')}>Allow once</button></div></Dialog>}{question && !questionHidden && <Dialog title="A question for you" onClose={() => setQuestionHidden(true)}><p className="approval-copy">{question.text}</p>{question.options?.map(option => <button className="question-option" key={option} onClick={() => void answerQuestion(option)}>{option}<ArrowRight size={16} /></button>)}<form onSubmit={event => { event.preventDefault(); void answerQuestion(answer); }}><label>Your answer<textarea value={answer} onChange={event => setAnswer(event.target.value)} required /></label><button className="button primary" type="submit" disabled={!answer.trim()}>Send answer<Send size={16} /></button></form></Dialog>}</div>;
}
