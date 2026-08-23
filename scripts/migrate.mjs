// ============================================================================
// scripts/migrate.mjs - create the database, apply the schema, seed it.
// ============================================================================
//   npm run db:migrate    apply schema + seed (fails if tables already exist)
//   npm run db:reset      drop everything first, then do the same
//
// This is not a real migration tool - there are no versioned up/down steps and
// no migrations table. v1 has one schema file, and the benchmark wants a clean
// database far more often than it wants incremental migrations.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shouldReset = process.argv.includes('--reset');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}

/**
 * Create the target database if it does not exist yet.
 *
 * CREATE DATABASE cannot run inside a transaction and cannot run from a
 * connection to the database being created, so this briefly connects to the
 * always-present `postgres` maintenance database instead.
 */
async function ensureDatabaseExists() {
  const target = new URL(databaseUrl);
  const databaseName = target.pathname.slice(1); // strip the leading "/"

  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();

  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);

    if (rowCount === 0) {
      // Identifiers cannot be parameterised, so the name is quoted instead.
      // It comes from our own DATABASE_URL, not from user input.
      await client.query(`CREATE DATABASE "${databaseName}"`);
      console.log(`  created database "${databaseName}"`);
    } else {
      console.log(`  database "${databaseName}" already exists`);
    }
  } finally {
    await client.end();
  }
}

async function run() {
  console.log('\nFlux - database setup\n');

  await ensureDatabaseExists();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (shouldReset) {
      // Dropping and recreating the schema is the fastest way to get back to
      // a known-empty database - it takes the tables, views, triggers and the
      // append-only function with it in one statement.
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log('  dropped and recreated schema "public"');
    }

    for (const file of ['001_schema.sql', '002_seed.sql']) {
      const sql = await readFile(path.join(projectRoot, 'db', file), 'utf8');
      await client.query(sql);
      console.log(`  applied ${file}`);
    }

    // Prove it worked, using the same view the benchmark reports on.
    const { rows } = await client.query('SELECT * FROM ledger_invariant');
    const { rows: balances } = await client.query(
      `SELECT name, balance_minor FROM account_balances ORDER BY kind, name`
    );

    console.log('\n  accounts:');
    for (const account of balances) {
      console.log(`    ${account.name.padEnd(26)} ${(account.balance_minor / 100).toFixed(2)}`);
    }

    console.log(`\n  invariant ok: ${rows[0].ok}  (sum of all entries: ${rows[0].global_sum_minor})`);
    console.log('\nDone.\n');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('\nMigration failed:', error.message);
  if (error.hint) console.error('Hint:', error.hint);
  process.exit(1);
});
