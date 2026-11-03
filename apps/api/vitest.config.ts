import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Covers replica-set startup; the mongod binary is fetched beforehand by `pnpm test:prepare`.
    hookTimeout: 60_000,
  },
});
