// `pnpm dev:local`: one command, no accounts. Starts a single-node in-memory MongoDB replica set
// (transactions need one), then the API against it, then the web app. Each "Try the demo" clones
// the Atlas seed into its own sandbox org, so there is nothing to seed up front beyond the indexes
// the API ensures at boot. Also used by Playwright's webServer.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const apiDir = fileURLToPath(new URL('..', import.meta.url));
const rootDir = fileURLToPath(new URL('../../..', import.meta.url));
const API_PORT = 3000;
const watch = !process.env.CI && !process.argv.includes('--no-watch');

const log = (msg: string) => console.log(`\x1b[36m[dev:local]\x1b[0m ${msg}`);

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const uri = replSet.getUri();
log(`in-memory replica set ready (${uri})`);

const children: ChildProcess[] = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await replSet.stop();
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

function run(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (!stopping) {
      log(`${name} exited with code ${code}; shutting down`);
      void stop(code ?? 1);
    }
  });
  children.push(child);
}

run('api', process.execPath, [...(watch ? ['--watch'] : []), 'src/server.ts'], apiDir, {
  PORT: String(API_PORT),
  MONGODB_URI: uri,
  MONGODB_DB: 'team-finder-local',
  // Local runs (and the e2e suite) create many sandboxes from one IP.
  DEMO_SESSIONS_PER_MINUTE: '1000',
});

// Start the web app only once the API answers with a connected database.
for (let i = 0; ; i++) {
  try {
    const res = await fetch(`http://localhost:${API_PORT}/api/health`);
    if (res.ok && ((await res.json()) as { db?: string }).db === 'up') break;
  } catch {
    // not listening yet
  }
  if (i > 120) {
    log('API did not become healthy within 60s');
    await stop(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
log('API is up; starting the web app on http://localhost:5173');
run('web', 'pnpm', ['--filter', '@team-finder/web', 'dev'], rootDir);
