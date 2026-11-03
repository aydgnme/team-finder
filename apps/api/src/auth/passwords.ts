import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto';

// Password hashing with argon2id from node:crypto (Node 24.7+; the repo pins 26), so there is no
// native dependency to build. Parameters follow the OWASP recommendation (m = 19 MiB, t = 2, p = 1).
// Hashes are stored as PHC strings, so parameters can be raised later without breaking old hashes.

const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

function derive(
  password: string,
  nonce: Buffer,
  p: { memory: number; passes: number; parallelism: number; tagLength: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    const options: Argon2Parameters = { message: password, nonce, ...p };
    argon2('argon2id', options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const tag = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const tag = await derive(password, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}

// Verified against when the email is unknown, so a miss costs as much time as a wrong password.
let dummy: Promise<string> | undefined;
export async function burnVerify(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}
