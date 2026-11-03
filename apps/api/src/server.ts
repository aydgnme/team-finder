import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connectDatabase, type Database } from './db/client.ts';
import { ensureIndexes } from './db/indexes.ts';

const config = loadConfig();
let database: Database | undefined;

const app = buildApp({
  ...(config.mongodbUri ? { getDatabase: () => database } : {}),
  secureCookies: config.production,
  trustProxy: config.trustProxy,
  rateLimits: config.rateLimits,
  logger: true,
});

// Listen before the database is reachable: an Atlas outage must surface as db "down"
// on /api/health (and 503s later), not as a crash/restart loop.
async function connectWithRetry(uri: string) {
  for (let delayMs = 1_000; !database; delayMs = Math.min(delayMs * 2, 30_000)) {
    try {
      const connected = await connectDatabase(uri, config.mongodbDb);
      if (!(await connected.isReplicaSet())) {
        app.log.error(
          'MongoDB at MONGODB_URI is not a replica set; transactions will fail. For local dev run "pnpm dev:local".',
        );
      }
      const report = await ensureIndexes(connected, app.log);
      app.log.info({ indexes: report.ensured }, 'database connected');
      database = connected;
    } catch (error) {
      app.log.error({ err: error, retryInMs: delayMs }, 'database connection failed');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const shutdown = async () => {
  await app.close();
  await database?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });

if (config.mongodbUri) {
  void connectWithRetry(config.mongodbUri);
} else {
  app.log.warn(
    'MONGODB_URI is not set: running without a database. Only /api/health works; the demo, candidates, ' +
      'proposals and approvals answer 503 DB_UNAVAILABLE. Run "pnpm dev:local" for an in-memory replica set.',
  );
}
