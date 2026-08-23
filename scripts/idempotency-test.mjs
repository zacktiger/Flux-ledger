// ============================================================================
// scripts/idempotency-test.mjs
// ============================================================================
// The scenario every payments interviewer asks about:
//
//   A user taps "Send 100 rupees". The response is slow. They tap again. The
//   mobile client retries on timeout. A proxy replays the request. Now five
//   identical requests are in flight and the user must be charged exactly once.
//
// The test fires the same idempotency key 100 times simultaneously and asserts:
//
//   1. exactly ONE transfer row exists for that key
//   2. exactly TWO ledger entries exist (one debit, one credit)
//   3. the source account was debited exactly once
//   4. the other 99 callers got the same transfer id back, not an error
//
//   npm run test:idempotency
// ============================================================================
import { query, closePool } from '../lib/db.js';
import { executeTransfer } from '../lib/transfer/index.js';
import { formatPaise } from '../lib/money.js';

const DUPLICATE_REQUESTS = 100;
const AMOUNT_MINOR = 10000; // 100 rupees

/** Print a check and remember whether everything has passed so far. */
let allPassed = true;
function check(description, actual, expected) {
  const passed = actual === expected;
  if (!passed) allPassed = false;
  console.log(
    `  ${passed ? 'PASS' : 'FAIL'}  ${description.padEnd(52)} ` +
      `expected ${expected}, got ${actual}`
  );
}

async function main() {
  console.log('\n=== Idempotency test ===\n');

  // --- Setup: two throwaway accounts, funded from the mint ------------------
  const tag = `idem-${Date.now()}`;

  const { rows: users } = await query(
    `INSERT INTO users (name, email) VALUES ($1, $2), ($3, $4) RETURNING id, email`,
    [
      'Idempotency source', `bench+idem-src-${tag}@flux.test`,
      'Idempotency sink',   `bench+idem-dst-${tag}@flux.test`,
    ]
  );

  const { rows: accounts } = await query(
    `INSERT INTO accounts (user_id, name, kind)
     VALUES ($1, $2, 'user'), ($3, $4, 'user')
     RETURNING id, name`,
    [
      users[0].id, `bench:${tag}:source`,
      users[1].id, `bench:${tag}:sink`,
    ]
  );

  const source = accounts.find((account) => account.name.endsWith(':source'));
  const destination = accounts.find((account) => account.name.endsWith(':sink'));

  const { rows: mint } = await query(`SELECT id FROM accounts WHERE kind = 'system' LIMIT 1`);
  await executeTransfer({
    sourceAccountId: mint[0].id,
    destAccountId: source.id,
    amountMinor: 100000, // 1,000 rupees
    strategy: 'for-update',
  });

  const openingBalance = await balanceOf(source.id);
  console.log(`  source account opens at ${formatPaise(openingBalance)}`);
  console.log(
    `  firing ${DUPLICATE_REQUESTS} concurrent requests for ` +
      `${formatPaise(AMOUNT_MINOR)}, all with the same key\n`
  );

  // --- The test: one key, 100 simultaneous requests ------------------------
  const idempotencyKey = `payment-${tag}`;

  const results = await Promise.all(
    Array.from({ length: DUPLICATE_REQUESTS }, () =>
      executeTransfer({
        sourceAccountId: source.id,
        destAccountId: destination.id,
        amountMinor: AMOUNT_MINOR,
        strategy: 'for-update',
        idempotencyKey,
      })
    )
  );

  // --- Assertions ----------------------------------------------------------
  const { rows: transferRows } = await query(
    'SELECT id, status FROM transfers WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  const { rows: entryRows } = await query(
    `SELECT COUNT(*)::int AS count
       FROM ledger_entries
      WHERE transfer_id IN (SELECT id FROM transfers WHERE idempotency_key = $1)`,
    [idempotencyKey]
  );

  const closingBalance = await balanceOf(source.id);
  const distinctIds = new Set(results.map((result) => result.transferId));
  const replayed = results.filter((result) => result.replayed).length;

  check('transfer rows created for the key', transferRows.length, 1);
  check('ledger entries written (1 debit + 1 credit)', entryRows[0].count, 2);
  check('distinct transfer ids returned to callers', distinctIds.size, 1);
  check('callers served a replay of the winner', replayed, DUPLICATE_REQUESTS - 1);
  check('source debited exactly once', openingBalance - closingBalance, AMOUNT_MINOR);

  console.log(`\n  balance: ${formatPaise(openingBalance)} -> ${formatPaise(closingBalance)}`);
  console.log(`  1 request did the work, ${replayed} got the same result back without redoing it.`);
  console.log(`\n  ${allPassed ? 'All checks passed.' : 'FAILURES - see above.'}\n`);

  if (!allPassed) process.exitCode = 1;
}

async function balanceOf(accountId) {
  const { rows } = await query(
    'SELECT balance_minor FROM account_balances WHERE account_id = $1',
    [accountId]
  );
  return rows[0].balance_minor;
}

main()
  .catch((error) => {
    console.error('\nTest failed to run:', error);
    process.exitCode = 1;
  })
  .finally(closePool);
