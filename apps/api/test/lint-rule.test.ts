import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Invariant 3 is enforced structurally: only apps/api/src/db may import the MongoDB driver.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const code = "import { MongoClient } from 'mongodb';\nexport const c = MongoClient;\n";

describe('tenant isolation lint rule', () => {
  it.each([
    ['apps/api/src/routes/leak.ts', 1],
    ['apps/api/src/services/leak.ts', 1],
    ['apps/web/src/leak.ts', 1],
    ['apps/api/src/db/ok.ts', 0],
  ])('%s -> %i error(s)', async (filePath, errors) => {
    const [result] = await new ESLint({ cwd: root }).lintText(code, { filePath: `${root}${filePath}` });
    const restricted = result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(errors);
  });
});
