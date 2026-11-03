import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connectDatabase, type Database } from './db/client.ts';

const config = loadConfig();
let database: Database | undefined;

const app = buildApp({
  ...(config.mongodbUri ? { pingDb: async () => (database ? database.ping() : false) } : {}),
  secureCookies: config.production,
  logger: true,
});

// Listen before the database is reachable: an Atlas outage must surface as db "down"
// on /api/health (and 503s later), not as a crash/restart loop.
async function connectWithRetry(uri: string) {
  for (let delayMs = 1_000; !database; delayMs = Math.min(delayMs * 2, 30_000)) {
    try {
      database = await connectDatabase(uri, config.mongodbDb);
      app.log.info('database connected');
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
  app.log.warn('MONGODB_URI is not set: running without a database (only /api/health works).');
}
