// ============================================================================
// scripts/demo-live.mjs - reproduce the race against the DEPLOYED app, live.
// ============================================================================
// This is a demo, not a measurement. `bench.mjs` is the measurement: it runs
// in one process against local Postgres with a known pool size, and its
// numbers are the ones quoted in the README.
//
// This script exists for the other job - convincing somebody watching that the
// result is real and not a table in a markdown file. It fires N genuinely
// simultaneous HTTP requests at the deployed API and then reads the ledger
// back:
//
//   npm run demo:live -- --strategy=naive        # account goes negative
//   npm run db:reset:prod                        # restore the clean seed
//   npm run demo:live -- --strategy=for-update   # the rest are rejected
//
// Why the timings here are NOT benchmark numbers: every transaction now pays
// Vercel -> Neon network latency, and `for-update` serialises transfers, so it
// pays that latency once per transfer instead of once overall. Measured on the
// live deployment: naive 4.7s, for-update 59.7s - a 12x gap where the local
// benchmark shows 453 tps vs 375. The direction is real; the magnitude is an
// artefact of running over the public internet. Say so before anyone asks.
//
// Unlike bench.mjs, this deliberately uses the *seed* accounts rather than
// throwaway `bench:` ones, because the whole point is to open the UI
// afterwards and see the damage. That also means it dirties the demo ledger,
// which is append-only: `npm run db:reset:prod` is the only way back.
// ============================================================================
import { query, closePool } from '../lib/db.js';
import { STRATEGY_NAMES } from '../lib/transfer/index.js';
import { formatPaise } from '../lib/money.js';

// ---------------------------------------------------------------------------
// Command line options
// ---------------------------------------------------------------------------
function readOption(name, fallback) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split('=')[1] : fallback;
}

const CONFIG = {
  strategy: readOption('strategy', 'naive'),
  transfers: Number(readOption('transfers', 40)),
  amountMinor: Number(readOption('amount', 30)) * 100,  // rupees -> paise
  baseUrl: (readOption('url', process.env.DEMO_URL ?? 'https://flux-ledger-theta.vercel.app'))
    .replace(/\/$/, ''),
};

if (!STRATEGY_NAMES.includes(CONFIG.strategy)) {
  console.error(`Unknown strategy "${CONFIG.strategy}". Pick one of: ${STRATEGY_NAMES.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reading the ledger
//
// The transfers go over HTTP, but the *verification* reads Postgres directly.
// That is deliberate: the claim being demonstrated is about the state of the
// ledger, so it should be read from the ledger rather than inferred from what
// the API said it did.
// ---------------------------------------------------------------------------
async function readLedger() {
  const { rows: accounts } = await query(
    `SELECT account_id, name, balance_minor
       FROM account_balances
      WHERE kind = 'user'
      ORDER BY name`
  );
  const { rows: invariant } = await query('SELECT * FROM ledger_invariant');
  return { accounts, invariant: invariant[0] };
}

function printAccounts(accounts) {
  for (const account of accounts) {
    const flag = account.balance_minor < 0 ? '  <-- OVERDRAWN' : '';
    console.log(`    ${account.name.padEnd(26)} ${formatPaise(account.balance_minor).padStart(12)}${flag}`);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
async function run() {
  const { accounts, invariant: before } = await readLedger();

  if (accounts.length < 2) {
    throw new Error('Need at least two user accounts. Run `npm run db:reset:prod` first.');
  }

  const [source, dest] = accounts;
  const demandMinor = CONFIG.transfers * CONFIG.amountMinor;

  console.log(`\nFlux - live race against ${CONFIG.baseUrl}\n`);
  console.log(`  strategy   ${CONFIG.strategy}`);
  console.log(`  firing     ${CONFIG.transfers} x ${formatPaise(CONFIG.amountMinor)} = ${formatPaise(demandMinor)}`);
  console.log(`  against    ${source.name}, holding ${formatPaise(source.balance_minor)}`);
  console.log(`\n  before:`);
  printAccounts(accounts);

  if (demandMinor <= source.balance_minor) {
    console.log(
      `\n  NOTE: demand (${formatPaise(demandMinor)}) does not exceed the balance, so even a` +
      `\n  broken strategy cannot overdraw. Raise --transfers or --amount.`
    );
  }

  // Wake the serverless function and the Neon compute with a plain page load
  // before timing anything. Neon's free tier suspends after five minutes idle,
  // and a cold start costs several seconds - which would land entirely on
  // whichever request happened to go first and make the tally hard to read.
  // A GET is used rather than a transfer so the warm-up moves no money.
  process.stdout.write('\n  waking the deployment... ');
  await fetch(CONFIG.baseUrl).catch(() => {});
  console.log('ok');

  // Promise.all is what makes this a race: every request is dispatched before
  // any of them is awaited, so they overlap inside Postgres rather than
  // queueing behind each other here.
  console.log(`  firing ${CONFIG.transfers} simultaneous requests...`);
  const startedAt = Date.now();

  const results = await Promise.all(
    Array.from({ length: CONFIG.transfers }, () =>
      fetch(`${CONFIG.baseUrl}/api/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: source.account_id,
          destAccountId: dest.account_id,
          amountMinor: CONFIG.amountMinor,
          strategy: CONFIG.strategy,
        }),
      })
        .then((response) => response.json().then((body) => ({ http: response.status, ...body })))
        // A failed request is a result too - it must not take the whole run
        // down, or one flaky socket loses the demo.
        .catch((error) => ({ http: 'ERR', status: 'network', reason: error.message }))
    )
  );

  const elapsedMs = Date.now() - startedAt;

  // --- what the API said -----------------------------------------------------
  const tally = new Map();
  for (const result of results) {
    const key = `${result.http} ${result.status}${result.reason ? ` / ${result.reason}` : ''}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  console.log(`\n  responses after ${(elapsedMs / 1000).toFixed(1)}s:`);
  for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)} x  ${outcome}`);
  }

  // --- what the ledger says --------------------------------------------------
  const { accounts: after, invariant } = await readLedger();
  console.log(`\n  after:`);
  printAccounts(after);

  console.log(`\n  ledger_invariant`);
  console.log(`    global sum        ${invariant.global_sum_minor}  (must be 0 - money is never created)`);
  console.log(`    unbalanced        ${invariant.unbalanced_transfers}`);
  console.log(`    overdrawn users   ${invariant.overdrawn_accounts}`);
  console.log(`    total overdraft   ${formatPaise(invariant.total_overdraft_minor)}`);
  console.log(`    ok                ${invariant.ok}`);

  // --- the point -------------------------------------------------------------
  // The two invariants are separate, and this is where that shows. Double-entry
  // is structural and survives the broken strategy; "no user account below
  // zero" is a business rule and does not.
  console.log('');
  if (invariant.overdrawn_accounts > 0) {
    console.log(
      `  ${CONFIG.strategy} let ${formatPaise(Math.abs(invariant.total_overdraft_minor))} out of an account that did not have it.`
    );
    console.log(
      `  Note that the global sum is still ${invariant.global_sum_minor}: double-entry held perfectly.`
    );
    console.log(`  The structure is fine. The business rule is not. Those fail independently.`);
  } else {
    console.log(`  ${CONFIG.strategy} held: nothing was spent that did not exist.`);
    console.log(`  Every rejected request above is a transfer that correctly did not happen.`);
  }
  console.log(`\n  Restore the clean seed with: npm run db:reset:prod\n`);

  // Deliberately no non-zero exit on an overdraft. bench.mjs and
  // idempotency-test.mjs are the test suite and fail loudly; here an overdraft
  // is the expected, desired outcome of --strategy=naive. This exits non-zero
  // only when the demo itself could not run.
}

run()
  .catch((error) => {
    console.error('\nDemo failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
