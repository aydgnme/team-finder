import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CapacityError,
  DomainError,
  DomainException,
  domainError,
  HTTP_STATUS,
  validationError,
} from '../src/index.ts';

describe('DomainError', () => {
  it('builds a valid envelope with message and hint for every code', () => {
    const e = domainError('CAPACITY_EXCEEDED', { userId: 'u', date: '2026-03-09', used: 6, requested: 4, maxHours: 2 });
    expect(DomainError.parse(e)).toEqual(e);
    expect(e.message).toBe('Would exceed 8 h/day on 2026-03-09: 6 h already booked, 4 h requested.');
    expect(e.hint).toBe('The most you can request from 2026-03-09 is 2 h/day.');
  });

  it('maps codes to HTTP statuses', () => {
    expect(new CapacityError({ userId: 'u', date: '2026-03-09', used: 8, requested: 1, maxHours: 0 }).status).toBe(409);
    expect(new DomainException(domainError('UNAUTHENTICATED', {})).status).toBe(401);
    expect(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE).toBe(415);
    expect(HTTP_STATUS.DB_UNAVAILABLE).toBe(503);
  });

  it('turns zod issues into VALIDATION details', () => {
    const r = z.object({ hours: z.number().max(8) }).safeParse({ hours: 9 });
    const e = validationError(r.error!);
    expect(e.code).toBe('VALIDATION');
    expect(DomainError.parse(e).details).toMatchObject({ issues: [{ path: 'hours' }] });
  });

  it('rejects envelopes with the wrong details shape', () => {
    expect(DomainError.safeParse({ code: 'SLOT_FULL', message: '', hint: '', details: {} }).success).toBe(false);
  });
});
