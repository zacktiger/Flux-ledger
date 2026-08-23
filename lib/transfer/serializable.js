// ============================================================================
// Strategy 4 of 4: SERIALIZABLE isolation + retry
// ============================================================================
// The other three strategies hand-build a correctness argument. This one
// delegates it to the database and writes the naive code on purpose.
//
// Look at the body below: read the balance, check it, write the entries. That
// is the naive strategy, character for character. The only difference is the
// isolation level on the BEGIN.
//
// Under SERIALIZABLE, Postgres tracks the read-write dependencies between
// concurrent transactions and guarantees the result is identical to some
// serial order of them. Our transaction reads a *range* of ledger_entries (the
// SUM for one account) and another transaction inserts into that same range -
// Postgres notices, decides the two cannot be ordered safely, and aborts one
// with SQLSTATE 40001. There is no lock and no version column; the conflict is
// detected rather than prevented.
//
// The catch, and the reason this is not a free lunch: **any** transaction can
// be aborted at **any** time with 40001, including ones that did nothing
// wrong. Application code MUST have a retry loop or SERIALIZABLE will simply
// surface as random errors in production. That loop is not optional garnish -
// it is half of the strategy.
// ============================================================================
import { withTransaction } from '../db.js';
import {
  getBalanceMinor,
  postLedgerEntries,
  markPosted,
  recordEvent,
  assertSufficientFunds,
  retryOnConflict,
  PG_SERIALIZATION_FAILURE,
  PG_DEADLOCK_DETECTED,
} from './shared.js';

export const serializable = {
  name: 'serializable',
  label: 'SERIALIZABLE + retry',
  description:
    'Naive read-then-write code running at SERIALIZABLE isolation. Postgres ' +
    'detects the conflict and aborts a transaction; we retry it.',

  async execute(transfer, { sourceKind }) {
    const { retries } = await retryOnConflict(
      // ---- one attempt -----------------------------------------------------
      async (attemptNumber) =>
        withTransaction(
          async (client) => {
            const balanceMinor = await getBalanceMinor(client, transfer.source_account_id);

            await recordEvent(client, transfer.id, 'balance.checked', {
              balance_minor: balanceMinor,
              required_minor: transfer.amount_minor,
              attempt: attemptNumber,
              strategy: 'serializable',
            });

            assertSufficientFunds({
              balanceMinor,
              amountMinor: transfer.amount_minor,
              sourceKind,
            });

            await postLedgerEntries(client, transfer);
            await markPosted(client, transfer.id);

            await recordEvent(client, transfer.id, 'ledger.posted', {
              entries: 2,
              attempt: attemptNumber,
              strategy: 'serializable',
            });

            // The COMMIT inside withTransaction is where 40001 usually lands.
            // Postgres can let every statement above succeed and still refuse
            // the commit - which is why the retry has to wrap the *whole*
            // transaction, not any single statement inside it.
          },
          { isolationLevel: 'SERIALIZABLE' }
        ),

      // ---- retry policy ----------------------------------------------------
      {
        isRetryable: (error) =>
          error.code === PG_SERIALIZATION_FAILURE || error.code === PG_DEADLOCK_DETECTED,

        // Written on a separate connection so it survives the rollback of the
        // attempt it describes.
        onRetry: (attemptNumber, error) =>
          recordEvent(null, transfer.id, 'attempt.conflict', {
            attempt: attemptNumber,
            sqlstate: error.code,
            reason: 'serialization failure, retrying',
            strategy: 'serializable',
          }),
      }
    );

    return { retries };
  },
};
