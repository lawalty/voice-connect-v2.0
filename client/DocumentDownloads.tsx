import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { GeneratedDownload } from '../contract/library';
import { api } from './api';

type Saved = { documents: GeneratedDownload[]; dismissed: string[] };
const revisionKey = (document: GeneratedDownload) => `${document.id}:${document.revision}${document.offer_id?`:${document.offer_id}`:''}`;
const filenameFor = (document: GeneratedDownload) => (document.filename || `${document.title}.pdf`).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_');
const formatFor = (document: GeneratedDownload) => /\.([a-z0-9]{1,8})$/i.exec(filenameFor(document))?.[1].toUpperCase() || 'FILE';
const validDocument = (value: unknown): value is GeneratedDownload => {
  const item = value as Partial<GeneratedDownload> | null;
  return Boolean(item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/i.test(item.id) && typeof item.title === 'string' && Number.isInteger(item.revision) && item.revision! > 0 && item.status === 'ready' && Number(item.chunk_count) > 0 && (item.filename === undefined || typeof item.filename === 'string') && (item.mime_type === undefined || typeof item.mime_type === 'string') && (item.offer_id === undefined || typeof item.offer_id === 'string'));
};

/** Keyed by conversation in App: requests and dismissals cannot cross conversations. */
export default function DocumentDownloads({ conversationId }: { conversationId: string }) {
  const storageKey = `vc2:document-downloads:${conversationId}`;
  const [saved, setSaved] = useState<Saved>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return { documents: Array.isArray(value.documents) ? value.documents.filter(validDocument).slice(0,200) : [], dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((item: unknown) => typeof item === 'string').slice(-1000) : [] };
    } catch { return { documents: [], dismissed: [] }; }
  });
  const [downloading, setDownloading] = useState('');
  const [error, setError] = useState('');
  const downloadRequest = useRef<AbortController | null>(null);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Dismissal still works in this session. */ } }, [saved, storageKey]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, busy = false;
    async function refresh() {
      if (controller.signal.aborted || busy) return;
      clearTimeout(timer);
      busy = true;
      try {
        if (document.visibilityState === 'visible') {
          const documents = await api<GeneratedDownload[]>(`/api/library/generated?conversation_id=${encodeURIComponent(conversationId)}`, { signal: controller.signal });
          if (!controller.signal.aborted && Array.isArray(documents)) setSaved(previous => {
            const merged = new Map(previous.documents.map(item => [item.id, item]));
            for (const item of documents.filter(validDocument)) merged.set(item.id, item);
            const next = { ...previous, documents: [...merged.values()].slice(-200) };
            return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
          });
        }
      } catch { /* Preserve existing downloads during transient Library outages. */ }
      finally { busy = false; if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 4000); }
    }
    void refresh();
    const resume = () => void refresh();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => { controller.abort(); clearTimeout(timer); downloadRequest.current?.abort(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); };
  }, [conversationId]);

  async function download(item: GeneratedDownload) {
    if (downloadRequest.current) return;
    const controller = new AbortController();downloadRequest.current = controller;
    setDownloading(item.id);setError('');
    try {
      const response = await fetch(`/api/library/documents/${item.id}/download`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('vc-auth-expired'));
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Download failed. Please try again.');
      }
      if (!response.headers.get('content-type')?.startsWith(item.mime_type || 'application/pdf')) throw new Error('The document is unavailable. Please try again.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url;anchor.download = filenameFor(item);
      document.body.append(anchor);anchor.click();anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Download failed. Please try again.');
    } finally { downloadRequest.current = null; if (!controller.signal.aborted) setDownloading(''); }
  }
  const visible = saved.documents.filter(item => !saved.dismissed.includes(revisionKey(item)));
  if (!visible.length) return null;
  return <section className="document-downloads" aria-label="Document downloads">
    <div className="document-download-list" aria-live="polite" aria-relevant="additions">
      {visible.map(item => <div className="document-download-pill" key={revisionKey(item)}>
        <a href={`/api/library/documents/${item.id}/download`} download aria-label={`Download ${item.title} (${formatFor(item)})`} aria-busy={downloading === item.id} onClick={event => { event.preventDefault(); void download(item); }}>
          <Download size={16} aria-hidden="true" /><span className="document-download-title">{item.title}</span><span className="document-download-format">{downloading === item.id ? 'Opening…' : formatFor(item)}</span>
        </a>
        <button type="button" aria-label={`Dismiss download for ${item.title}`} onClick={() => { setSaved(previous => ({...previous, dismissed: [...previous.dismissed, revisionKey(item)].slice(-1000)})); setError(''); }}><X size={15} aria-hidden="true" /></button>
      </div>)}
    </div>
    {error && <p className="document-download-error" role="alert">{error}</p>}
  </section>;
}
