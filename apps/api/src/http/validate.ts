import { DomainException, validationError } from '@team-finder/domain';
import type { z } from 'zod';

/** zod parse that throws a VALIDATION DomainException (400) instead of a ZodError. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new DomainException(validationError(r.error));
  return r.data;
}
