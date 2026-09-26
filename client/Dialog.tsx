import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Dialog({ title, onClose, children, wide = false, closeDisabled = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => { if (!closeDisabled) onClose(); };
  const closer = useRef(close); closer.current = close;
  useEffect(() => {
    const dialog = ref.current!; const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); closer.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby="dialog-title" onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="dialog-inner"><header className="dialog-header"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={close} disabled={closeDisabled} aria-label={`Close ${title}`}><X size={19} /></button></header>{children}</div></dialog>;
}
