import { describe, expect, it } from 'vitest';
import { HealthResponse, HOURS_PER_DAY } from '../src/index.ts';

describe('HealthResponse', () => {
  it('accepts a valid payload', () => {
    expect(HealthResponse.parse({ status: 'ok', db: 'up', cookieRoundTrip: true })).toEqual({
      status: 'ok',
      db: 'up',
      cookieRoundTrip: true,
    });
  });

  it('rejects an unknown db state', () => {
    expect(HealthResponse.safeParse({ status: 'ok', db: 'maybe', cookieRoundTrip: false }).success).toBe(false);
  });
});

describe('HOURS_PER_DAY', () => {
  it('is 8 per the SRS', () => {
    expect(HOURS_PER_DAY).toBe(8);
  });
});
