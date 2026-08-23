// ============================================================================
// Pieces every transfer strategy needs.
// ============================================================================
// The four strategies differ in exactly one way: how they stop two concurrent
// transfers from both believing the same rupee is available. Everything else -
// reading a balance, writing the two ledger entries, recording events - is
// identical, and lives here so the strategy files stay small enough to read
// side by side.
// ============================================================================
import { pool } from '../db.js';

/** A transfer that failed for a reason we understand and can explain. */
export class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

/**
 * Thrown when a strategy detects that another transaction beat it to the
 * punch. The retry loop catches this; nothing else should.
 */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

// Postgres SQLSTATE codes we know how to react to.
export const PG_SERIALIZATION_FAILURE = '40001'; // SERIALIZABLE could not order the transactions
export const PG_DEADLOCK_DETECTED     = '40P01'; // two transactions waiting on each other
export const PG_UNIQUE_VIOLATION      = '23505'; // our idempotency key collided

/**
 * The current balance of an account, in paise.
 *
 * This is THE query the whole project is built around: a balance is never read
 * from a column, it is summed from the ledger. `client` may be a pooled
 * connection or a transaction - the isolation level of the surrounding
 * transaction is what decides whether this read is safe.
 */
export async function getBalanceMinor(client, accountId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_minor), 0)::BIGINT AS balance_minor
       FROM ledger_entries
      WHERE account_id = $1`,
    [accountId]
  );
  return rows[0].balance_minor;
}

/**
 * Write the two rows that *are* the money: a debit on the source and a
 * matching credit on the destination. They sum to zero by construction, which
 * is what keeps the global invariant true.
 */
export async function postLedgerEntries(client, transfer) {
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, amount_minor)
     VALUES ($1, $2, $3),
            ($1, $4, $5)`,
    [
      transfer.id,
      transfer.source_account_id,
      -transfer.amount_minor, // debit: money leaves
      transfer.dest_account_id,
      transfer.amount_minor,  // credit: money arrives
    ]
  );
}

/** Mark the transfer settled. Called in the same transaction as the entries. */
export async function markPosted(client, transferId) {
  await client.query(
    `UPDATE transfers SET status = 'posted', settled_at = now() WHERE id = $1`,
    [transferId]
  );
}

/**
 * Mark the transfer failed. No ledger entries exist when this is called.
 *
 * Like recordEvent, `client` may be null. The caller is usually reacting to a
 * transaction that has already rolled back, so there is no transaction left to
 * write this into and it goes out on its own connection.
 */
export async function markFailed(client, transferId, reason) {
  const executor = client ?? pool;
  await executor.query(
    `UPDATE transfers
        SET status = 'failed', failure_reason = $2, settled_at = now()
      WHERE id = $1`,
    [transferId, reason]
  );
}

/**
 * Append one row to the transfer timeline.
 *
 * Pass a `client` to record the event inside a transaction - it will roll back
 * with everything else if the transaction aborts. Pass nothing to write it on
 * its own connection, which is what the retry loop does: a conflict event
 * describes an attempt that *was* rolled back, so it has to survive that
 * rollback to be visible on the timeline.
 */
export async function recordEvent(client, transferId, type, detail = {}) {
  const executor = client ?? pool;
  await executor.query(
    `INSERT INTO events (transfer_id, type, detail) VALUES ($1, $2, $3)`,
    [transferId, type, JSON.stringify(detail)]
  );
}

/**
 * Reject the transfer if the source cannot cover it.
 *
 * System accounts are exempt: the mint is the origin of all money in the
 * system, so it is *expected* to sit at a negative balance. Only user accounts
 * are held to "you cannot spend what you do not have".
 */
export function assertSufficientFunds({ balanceMinor, amountMinor, sourceKind }) {
  if (sourceKind === 'system') return;

  if (balanceMinor < amountMinor) {
    throw new TransferError(
      'INSUFFICIENT_FUNDS',
      `Insufficient funds: balance ${balanceMinor} paise, needed ${amountMinor} paise`
    );
  }
}

/**
 * Run `attempt` until it succeeds or we run out of patience.
 *
 * Used by the two strategies that detect conflicts instead of preventing them
 * (optimistic and serializable). Both of those are *expected* to fail
 * occasionally under load - that is the design - so the retry loop is part of
 * the strategy, not error handling bolted on afterwards.
 *
 * @param {(attemptNumber: number) => Promise<any>} attempt
 * @param {{ maxAttempts?: number, isRetryable: (error: Error) => boolean,
 *           onRetry?: (attemptNumber: number, error: Error) => Promise<void> }} options
 * @returns {Promise<{ value: any, retries: number }>}
 */
export async function retryOnConflict(attempt, options) {
  const { maxAttempts = 25, isRetryable, onRetry } = options;

  let retries = 0;

  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      const value = await attempt(attemptNumber);
      return { value, retries };
    } catch (error) {
      // Not a conflict, or we have retried enough: give up and let the caller
      // deal with it.
      if (!isRetryable(error) || attemptNumber >= maxAttempts) throw error;

      retries++;
      if (onRetry) await onRetry(attemptNumber, error);

      // Randomised exponential backoff. Without the jitter, every loser of a
      // race wakes up at the same moment and collides again - the retries
      // synchronise instead of spreading out.
      const baseDelayMs = Math.min(2 ** attemptNumber, 50);
      await sleep(Math.random() * baseDelayMs);
    }
  }
}

/** Promise-based sleep, used for backoff and for the naive strategy demo. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
