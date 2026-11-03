import { z } from 'zod';

/** Shape of GET /api/health, shared by api and web. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  db: z.enum(['up', 'down', 'not_configured']),
  cookieRoundTrip: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
