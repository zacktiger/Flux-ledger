// ============================================================================
// scripts/bench.mjs - the benchmark. This is the point of the project.
// ============================================================================
// Setup, for each of the four strategies:
//
//   * a brand new account funded with exactly 1,000 rupees
//   * 200 transfers of 10 rupees each, all fired at the same instant
//
// 200 x 10 = 2,000 rupees of demand against 1,000 rupees of supply. A correct
// system posts exactly 100 of them and rejects the other 100. Anything more
// than 100 successes is money that did not exist being spent.
//
//   npm run bench
//   npm run bench -- --transfers=500 --amount=10 --balance=1000
//   npm run bench -- --strategies=naive,for-update
//
// Each run creates its own accounts rather than wiping the ledger, because the
// ledger cannot be wiped - it is append-only, enforced by trigger. Run
// `npm run db:reset` for a genuinely clean database.
// ============================================================================
import { query, pool, closePool } from '../lib/db.js';
import { executeTransfer, STRATEGY_NAMES, STRATEGIES } from '../lib/transfer/index.js';
import { formatPaise } from '../lib/money.js';
import { writeFile, mkdir } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Command line options
// ---------------------------------------------------------------------------
function readOption(name, fallback) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split('=')[1] : fallback;
}

const CONFIG = {
  transfers: Number(readOption('transfers', 200)),
  amountMinor: Number(readOption('amount', 10)) * 100,   // rupees -> paise
  openingMinor: Number(readOption('balance', 1000)) * 100,
  strategies: readOption('strategies', STRATEGY_NAMES.join(',')).split(','),
};

// ---------------------------------------------------------------------------
// Scenario setup
// ---------------------------------------------------------------------------

/**
 * Build a clean, isolated scenario for one strategy: a funded source account
 * and an empty destination account, both owned by throwaway users the UI knows
 * to hide (their emails start with "bench+").
 */
async function createScenario(strategyName) {
  const stamp = Date.now();
  const tag = `${strategyName}-${stamp}`;

  const { rows: users } = await query(
    `INSERT INTO users (name, email) VALUES
       ($1, $2), ($3, $4)
     RETURNING id, email`,
    [
      `Bench source (${strategyName})`, `bench+src-${tag}@flux.test`,
      `Bench sink (${strategyName})`,   `bench+dst-${tag}@flux.test`,
    ]
  );

  const sourceUser = users.find((user) => user.email.startsWith('bench+src'));
  const destUser = users.find((user) => user.email.startsWith('bench+dst'));

  const { rows: accounts } = await query(
    `INSERT INTO accounts (user_id, name, kind) VALUES
       ($1, $2, 'user'), ($3, $4, 'user')
     RETURNING id, name`,
    [
      sourceUser.id, `bench:${tag}:source`,
      destUser.id,   `bench:${tag}:sink`,
    ]
  );

  const source = accounts.find((account) => account.name.endsWith(':source'));
  const destination = accounts.find((account) => account.name.endsWith(':sink'));

  // Fund the source through the real transfer path - no special-case inserts,
  // no balance column to set. Money comes out of the mint like it always does.
  const { rows: mint } = await query(`SELECT id FROM accounts WHERE kind = 'system' LIMIT 1`);

  const funding = await executeTransfer({
    sourceAccountId: mint[0].id,
    destAccountId: source.id,
    amountMinor: CONFIG.openingMinor,
    strategy: 'for-update',
  });

  if (funding.status !== 'posted') {
    throw new Error(`Could not fund the benchmark account: ${funding.reason}`);
  }

  return { sourceId: source.id, destId: destination.id };
}

/** The current balance of one account, straight from the derived view. */
async function balanceOf(accountId) {
  const { rows } = await query(
    'SELECT balance_minor FROM account_balances WHERE account_id = $1',
    [accountId]
  );
  return rows[0].balance_minor;
}

/**
 * Open every pooled connection before timing anything.
 *
 * Without this the first strategy measured pays for the TCP handshakes and
 * authentication of the whole pool, and looks slower than it is.
 */
async function warmUpPool() {
  const clients = await Promise.all(
    Array.from({ length: pool.options.max }, () => pool.connect())
  );
  clients.forEach((client) => client.release());
}

// ---------------------------------------------------------------------------
// One strategy, start to finish
// ---------------------------------------------------------------------------
async function runStrategy(strategyName) {
  const { sourceId, destId } = await createScenario(strategyName);

  const startingBalance = await balanceOf(sourceId);

  // --- the actual test -----------------------------------------------------
  // Every promise is created before any of them is awaited, so all N requests
  // are in flight together. How many run inside Postgres at once is capped by
  // DB_POOL_MAX; the rest queue in the client, exactly like real traffic
  // arriving faster than a connection pool can absorb it.
  const startedAt = process.hrtime.bigint();

  const results = await Promise.all(
    Array.from({ length: CONFIG.transfers }, () =>
      executeTransfer({
        sourceAccountId: sourceId,
        destAccountId: destId,
        amountMinor: CONFIG.amountMinor,
        strategy: strategyName,
      }).catch((error) => ({
        // A strategy is expected to *return* failures, not throw them. If one
        // throws anyway we record it rather than letting Promise.all abandon
        // the other 199 results.
        status: 'error',
        reason: error.message,
        retries: 0,
      }))
    )
  );

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  // --- what happened -------------------------------------------------------
  const posted = results.filter((result) => result.status === 'posted').length;
  const rejected = results.filter((result) => result.status === 'failed').length;
  const errored = results.filter((result) => result.status === 'error').length;
  const retries = results.reduce((total, result) => total + (result.retries ?? 0), 0);

  const finalBalance = await balanceOf(sourceId);

  // Overdraft is the amount the account went below zero. A correct strategy
  // lands on exactly 0 and this is 0.
  const overdraftMinor = Math.min(finalBalance, 0);

  // How many transfers *should* have succeeded, given the money available.
  const affordable = Math.floor(startingBalance / CONFIG.amountMinor);

  return {
    strategy: strategyName,
    label: STRATEGIES[strategyName].label,
    posted,
    rejected,
    errored,
    retries,
    affordable,
    overdraftMinor,
    finalBalance,
    elapsedMs,
    throughput: CONFIG.transfers / (elapsedMs / 1000),
    correct: overdraftMinor === 0 && posted === affordable,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function buildHeadlineTable(results) {
  const rows = results.map((result) => [
    result.strategy,
    formatPaise(result.overdraftMinor),
    String(result.posted),
    `${result.throughput.toFixed(1)} tps`,
    String(result.retries),
  ]);

  return renderMarkdownTable(
    ['Strategy', `Overdraft @ ${CONFIG.transfers} concurrent`, 'Successful', 'Throughput', 'Retries'],
    rows
  );
}

function buildDetailTable(results) {
  const rows = results.map((result) => [
    result.strategy,
    `${result.posted} / ${result.affordable}`,
    String(result.rejected),
    String(result.errored),
    formatPaise(result.finalBalance),
    `${result.elapsedMs.toFixed(0)} ms`,
    result.correct ? 'PASS' : 'FAIL',
  ]);

  return renderMarkdownTable(
    ['Strategy', 'Posted / affordable', 'Rejected', 'Errored', 'Final balance', 'Wall time', 'Correct'],
    rows
  );
}

/** Render a markdown table with each column padded to its widest cell. */
function renderMarkdownTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length))
  );

  const line = (cells) => `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;

  return [
    line(headers),
    `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== Flux concurrency benchmark ===\n');
  console.log(`  ${CONFIG.transfers} concurrent transfers of ${formatPaise(CONFIG.amountMinor)}`);
  console.log(`  against an opening balance of ${formatPaise(CONFIG.openingMinor)}`);
  console.log(`  pool size: ${pool.options.max} connections`);
  console.log(
    `  a correct strategy posts exactly ` +
      `${Math.floor(CONFIG.openingMinor / CONFIG.amountMinor)} of them\n`
  );

  await warmUpPool();

  const results = [];
  for (const strategyName of CONFIG.strategies) {
    if (!STRATEGIES[strategyName]) {
      throw new Error(`Unknown strategy "${strategyName}"`);
    }

    process.stdout.write(`  running ${strategyName.padEnd(14)}`);
    const result = await runStrategy(strategyName);
    results.push(result);

    console.log(
      `${result.correct ? 'ok  ' : 'BUG '} ` +
        `posted ${String(result.posted).padStart(3)}, ` +
        `overdraft ${formatPaise(result.overdraftMinor)}, ` +
        `${result.elapsedMs.toFixed(0)} ms`
    );
  }

  // --- the global invariant ------------------------------------------------
  // Note what this checks and what it does not. Double-entry guarantees no
  // money is created or destroyed - and it holds even for the naive strategy,
  // because every transfer still writes a matching debit and credit. What it
  // does NOT guarantee is that an account stays above zero. That is a business
  // rule, and only concurrency control enforces it.
  const { rows: invariantRows } = await query(
    `SELECT global_sum_minor, unbalanced_transfers, overdrawn_accounts,
            total_overdraft_minor
       FROM ledger_invariant`
  );
  const invariant = invariantRows[0];

  const report = [
    `### Results`,
    ``,
    buildHeadlineTable(results),
    ``,
    `### Detail`,
    ``,
    buildDetailTable(results),
    ``,
    `### Ledger integrity (whole database, after every run above)`,
    ``,
    '```',
    `SELECT * FROM ledger_invariant;`,
    ``,
    `  global_sum_minor      ${invariant.global_sum_minor}   <- money created or destroyed`,
    `  unbalanced_transfers  ${invariant.unbalanced_transfers}   <- transfers whose entries do not sum to zero`,
    `  overdrawn_accounts    ${invariant.overdrawn_accounts}   <- accounts pushed below zero`,
    `  total_overdraft_minor ${invariant.total_overdraft_minor}`,
    '```',
    ``,
    invariant.global_sum_minor === 0 && invariant.unbalanced_transfers === 0
      ? `Double-entry held throughout: no money was created or destroyed by any strategy, ` +
        `including the broken one. The overdrawn accounts are the naive strategy spending ` +
        `money that was already spent.`
      : `WARNING: the ledger is corrupt. Investigate before trusting any number above.`,
    ``,
    `<sub>Generated by \`npm run bench\` on ${new Date().toISOString()} - ` +
      `Node ${process.version}, pool size ${pool.options.max}.</sub>`,
    ``,
  ].join('\n');

  console.log(`\n${report}`);

  await mkdir('docs', { recursive: true });
  await writeFile('docs/benchmark-results.md', report, 'utf8');
  console.log('Written to docs/benchmark-results.md\n');
}

main()
  .catch((error) => {
    console.error('\nBenchmark failed:', error);
    process.exitCode = 1;
  })
  .finally(closePool);
