import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { users, closeDb, isDbConfigured } from './mongo.js';
import { hashPassword } from './auth.js';
import type { UserDoc } from './mongo.js';

/**
 * Seed login accounts into MongoDB.
 *
 * Usage:
 *   npm run seed                 # reads server/seed-users.json
 *   npm run seed path/to.json    # reads a custom file
 *
 * File format (array):
 *   [
 *     { "username": "admin", "password": "secret", "name": "Admin" },
 *     { "username": "sales", "password": "..."                      }
 *   ]
 *
 * Passwords are hashed with bcrypt before storage; the plaintext is never saved.
 * Re-running updates existing users (by username) — safe to run repeatedly.
 */

const here = dirname(fileURLToPath(import.meta.url));

const userSchema = z.object({
  username: z.string().min(1).trim(),
  password: z.string().min(1),
  name: z.string().trim().optional(),
});
const fileSchema = z.array(userSchema).min(1, 'provide at least one user');

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error('❌ MONGODB_URI is not set. Add it to .env, then re-run.');
    process.exit(1);
  }

  const arg = process.argv[2];
  const path = arg ? resolve(process.cwd(), arg) : join(here, '..', 'seed-users.json');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`❌ Could not read seed file: ${path}`);
    console.error('   Create it (see server/seed-users.example.json) or pass a path.');
    process.exit(1);
  }

  const parsed = fileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error('❌ Invalid seed file:', parsed.error.flatten());
    process.exit(1);
  }

  const col = await users();
  let created = 0;
  let updated = 0;

  for (const u of parsed.data) {
    const _id = u.username.toLowerCase();
    const passwordHash = await hashPassword(u.password);
    const now = new Date().toISOString();
    const res = await col.updateOne(
      { _id },
      {
        $set: {
          username: u.username,
          name: u.name ?? null,
          passwordHash,
        } satisfies Partial<UserDoc>,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    if (res.upsertedCount === 1) created++;
    else updated++;
    console.log(`  • ${u.username}  (${res.upsertedCount === 1 ? 'created' : 'updated'})`);
  }

  console.log(`\n✅ Seed complete: ${created} created, ${updated} updated.`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('❌ Seed failed:', err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
