import { useSyncExternalStore } from 'react';

// "Your demo session ended": any 401 after the session was established opens the modal.
let ended = false;
const listeners = new Set<() => void>();

export function setSessionEnded(value: boolean) {
  ended = value;
  listeners.forEach((l) => l());
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ended,
  );
}
