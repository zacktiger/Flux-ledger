// ============================================================================
// Strategy 3 of 4: optimistic concurrency control (version column + retry)
// ============================================================================
// The opposite bet from FOR UPDATE. Instead of assuming a collision and
// locking to prevent it, we assume no collision, and check afterwards whether
// we were wrong.
//
//     1. read the account version (say, 7) and the balance
//     2. check the balance
//     3. UPDATE accounts SET version = 8 WHERE id = $1 AND version = 7
//     4. did that update 1 row?
//          yes -> nobody moved while we were thinking. Our read is still valid.
//          no  -> somebody committed first and the version is no longer 7.
//                 Our balance is stale. Throw it away and start over.
//
// Step 3 is the whole trick. It is a single atomic statement, so the check
// ("is the version still 7?") and the claim ("now it is 8") cannot be split
// apart by another transaction.
//
// Cost: wasted work. Under heavy contention on one account, most attempts lose
// the race and get redone - the `retries` column in the benchmark is that
// waste, measured. It shines when contention is rare and hurts when it is not.
// ============================================================================
import { withTransaction } from '../db.js';
import {
  getBalanceMinor,
  postLedgerEntries,
  markPosted,
  recordEvent,
  assertSufficientFunds,
  retryOnConflict,
  ConflictError,
} from './shared.js';

export const optimistic = {
  name: 'optimistic',
  label: 'optimistic (version + retry)',
  description:
    'Reads a version number with the balance, then commits only if the ' +
    'version is unchanged. Losers retry with backoff.',

  async execute(transfer, { sourceKind }) {
    const { retries } = await retryOnConflict(
      // ---- one attempt -----------------------------------------------------
      async (attemptNumber) =>
        withTransaction(async (client) => {
          // Read the version and the balance together. No lock is taken here -
          // that is the "optimistic" part.
          const { rows } = await client.query(
            'SELECT version FROM accounts WHERE id = $1',
            [transfer.source_account_id]
          );
          const expectedVersion = rows[0].version;

          const balanceMinor = await getBalanceMinor(client, transfer.source_account_id);

          await recordEvent(client, transfer.id, 'balance.checked', {
            balance_minor: balanceMinor,
            required_minor: transfer.amount_minor,
            version: expectedVersion,
            attempt: attemptNumber,
            strategy: 'optimistic',
          });

          // A shortfall is a real answer, not a race. Retrying would not
          // conjure up money, so this error escapes the retry loop.
          assertSufficientFunds({
            balanceMinor,
            amountMinor: transfer.amount_minor,
            sourceKind,
          });

          // The compare-and-swap. If another transaction has committed since
          // our read, `version` no longer matches and this updates 0 rows.
          const claim = await client.query(
            `UPDATE accounts
                SET version = version + 1
              WHERE id = $1 AND version = $2`,
            [transfer.source_account_id, expectedVersion]
          );

          if (claim.rowCount === 0) {
            // Our balance reading is stale. Abandon the attempt - the thrown
            // error rolls the transaction back, so no entries are written.
            throw new ConflictError(
              `Version conflict on account ${transfer.source_account_id}: ` +
                `expected ${expectedVersion}, someone else got there first`
            );
          }

          await postLedgerEntries(client, transfer);
          await markPosted(client, transfer.id);

          await recordEvent(client, transfer.id, 'ledger.posted', {
            entries: 2,
            attempt: attemptNumber,
            strategy: 'optimistic',
          });
        }),

      // ---- retry policy ----------------------------------------------------
      {
        isRetryable: (error) => error instanceof ConflictError,

        // Recorded with no client, i.e. on a separate connection: this event
        // describes an attempt that was just rolled back, so writing it inside
        // that transaction would erase it along with everything else.
        onRetry: (attemptNumber) =>
          recordEvent(null, transfer.id, 'attempt.conflict', {
            attempt: attemptNumber,
            reason: 'version changed under us, retrying',
            strategy: 'optimistic',
          }),
      }
    );

    return { retries };
  },
};
