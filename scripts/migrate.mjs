// Applies supabase/migrations/*.sql in order, once each, inside transactions.
// Tracked in a _migrations table so re-running is safe.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const ref = env.PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1]
const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

await client.connect()
await client.query(`
  create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`)
// Internal bookkeeping — never exposed to the public role.
await client.query('alter table _migrations enable row level security')
await client.query('revoke all on _migrations from anon')

const applied = new Set(
  (await client.query('select name from _migrations')).rows.map((r) => r.name),
)

const dir = 'supabase/migrations'
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
let ran = 0

for (const file of files) {
  if (applied.has(file)) {
    console.log(`  ⏭  ${file} (already applied)`)
    continue
  }
  const sql = readFileSync(join(dir, file), 'utf8')
  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('insert into _migrations (name) values ($1)', [file])
    await client.query('commit')
    console.log(`  ✅ ${file}`)
    ran++
  } catch (e) {
    await client.query('rollback')
    console.log(`  ❌ ${file}`)
    console.log(`     ${e.message}`)
    if (e.position) {
      const upto = sql.slice(0, Number(e.position))
      console.log(
        `     at line ${upto.split('\n').length}: ${upto.split('\n').pop().trim().slice(0, 80)}`,
      )
    }
    await client.end()
    process.exit(1)
  }
}

console.log(`\n${ran} migration(s) applied, ${files.length - ran} skipped.`)
await client.end()
