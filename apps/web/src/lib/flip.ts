import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * FLIP reorder for children marked `data-flip-key`: when `trigger` changes, items slide from their
 * old position (240 ms). Off under prefers-reduced-motion. Used only on settle, never while the
 * scrubber moves (design.md, /autoplan #2 Pass 7).
 */
export function useFlip(container: RefObject<HTMLElement | null>, trigger: unknown) {
  const previous = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const next = new Map<string, number>();
    for (const item of root.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const key = item.dataset.flipKey!;
      const top = item.getBoundingClientRect().top;
      next.set(key, top);
      const before = previous.current.get(key);
      if (reduce || before === undefined || typeof item.animate !== 'function') continue;
      const dy = before - top;
      if (Math.abs(dy) > 1) {
        item.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          duration: 240,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        });
      }
    }
    previous.current = next;
  }, [container, trigger]);
}
