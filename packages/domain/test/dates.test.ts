import { describe, expect, it } from 'vitest';
import { Day } from '../src/index.ts';

describe('Day', () => {
  it.each(['2026-03-09', '2028-02-29', '2026-12-31'])('accepts %s', (d) => {
    expect(Day.safeParse(d).success).toBe(true);
  });

  // Each of these used to pass the pattern and be rolled over by Date (02-30 -> 03-02).
  it.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-3-9', 'tomorrow'])(
    'rejects %s',
    (d) => {
      expect(Day.safeParse(d).success).toBe(false);
    },
  );
});
