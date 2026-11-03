import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

type Announce = (text: string, tone?: Toast['tone'], options?: { toast?: boolean }) => void;
const Ctx = createContext<Announce>(() => {});

/**
 * One aria-live region for the whole app ("Mira proposed for Backend. Coverage 100%.") plus a
 * visible toast with the same text, so state changes are never conveyed visually only.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const announce = useCallback<Announce>((text, tone = 'info', options) => {
    // Re-setting identical text would not be re-announced; clear first.
    setMessage('');
    requestAnimationFrame(() => setMessage(text));
    if (options?.toast === false) return;
    const id = ++next.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <Ctx.Provider value={announce}>
      {children}
      <div className="sr-only" aria-live="polite" data-testid="live-region">
        {message}
      </div>
      <div className="toasts" aria-hidden="true">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useAnnounce = () => useContext(Ctx);
