import { HealthResponse } from '@team-finder/domain';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return HealthResponse.parse(await res.json());
}
