import { useSyncExternalStore } from 'react';
import { storage } from './route.ts';

/** Max two coach-marks, dismissible, never shown again after dismissal (best effort). */
export type CoachStep = 'switchToManager' | 'tryConflict';

let current: CoachStep | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const key = (step: CoachStep) => `tf.coach.${step}.dismissed`;

export const coach = {
  show(step: CoachStep) {
    if (storage.get(key(step)) === '1' || current === step) return;
    current = step;
    emit();
  },
  dismiss(step: CoachStep) {
    storage.set(key(step), '1');
    if (current === step) current = null;
    emit();
  },
  hide() {
    current = null;
    emit();
  },
};

export function useCoach(): CoachStep | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
