// ============================================================================
// The one entry point for moving money.
// ============================================================================
// Everything that is the same regardless of concurrency strategy happens here:
// validating the request, claiming the idempotency key, creating the transfer
// row, and recording the outcome. The chosen strategy is handed an already
// created transfer and is responsible for exactly one thing - moving the money
// without letting a concurrent transfer corrupt the balance.
// ============================================================================
import { query } from '../db.js';
import { naive } from './naive.js';
import { forUpdate } from './for-update.js';
import { optimistic } from './optimistic.js';
import { serializable } from './serializable.js';
import { TransferError, markFailed, recordEvent } from './shared.js';

/** Every strategy, keyed by the name used in the API and the benchmark. */
export const STRATEGIES = {
  [naive.name]: naive,
  [forUpdate.name]: forUpdate,
  [optimistic.name]: optimistic,
  [serializable.name]: serializable,
};

/** Benchmark and UI order: broken first, so the table tells a story. */
export const STRATEGY_NAMES = ['naive', 'for-update', 'optimistic', 'serializable'];

export const DEFAULT_STRATEGY = 'for-update';

/**
 * Move money from one account to another.
 *
 * @param {object} request
 * @param {string}  request.sourceAccountId
 * @param {string}  request.destAccountId
 * @param {number}  request.amountMinor      Positive integer paise.
 * @param {string} [request.strategy]        One of STRATEGY_NAMES.
 * @param {string} [request.idempotencyKey]  Replay guard; see below.
 *
 * @returns {Promise<{ transferId: string, status: 'posted'|'failed',
 *                     reason: string|null, retries: number,
 *                     replayed: boolean, durationMs: number }>}
 */
export async function executeTransfer({
  sourceAccountId,
  destAccountId,
  amountMinor,
  strategy = DEFAULT_STRATEGY,
  idempotencyKey = null,
}) {
  const startedAt = Date.now();

  // --- 1. Validate the request ---------------------------------------------
  // Cheap checks first, before we touch the database. The schema enforces all
  // of these too - these exist to produce a readable message instead of a
  // constraint violation.
  const chosen = STRATEGIES[strategy];
  if (!chosen) {
    throw new TransferError(
      'UNKNOWN_STRATEGY',
      `Unknown strategy "${strategy}". Expected one of: ${STRATEGY_NAMES.join(', ')}`
    );
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new TransferError(
      'INVALID_AMOUNT',
      `Amount must be a positive whole number of paise, got ${amountMinor}`
    );
  }
  if (sourceAccountId === destAccountId) {
    throw new TransferError('INVALID_ACCOUNTS', 'Cannot transfer to the same account');
  }

  // --- 2. Look up the accounts ---------------------------------------------
  // We need `kind` because system accounts are allowed to go negative.
  const { rows: accounts } = await query(
    'SELECT id, kind FROM accounts WHERE id = ANY($1::uuid[])',
    [[sourceAccountId, destAccountId]]
  );

  const source = accounts.find((account) => account.id === sourceAccountId);
  const destination = accounts.find((account) => account.id === destAccountId);

  if (!source) throw new TransferError('NO_SUCH_ACCOUNT', `No account ${sourceAccountId}`);
  if (!destination) throw new TransferError('NO_SUCH_ACCOUNT', `No account ${destAccountId}`);

  // --- 3. Claim the idempotency key ----------------------------------------
  // This single statement is the entire idempotency mechanism.
  //
  // transfers.idempotency_key is UNIQUE, so if two identical requests arrive
  // at the same instant only one of them can insert this row. ON CONFLICT DO
  // NOTHING makes the loser return zero rows instead of raising an error, and
  // zero rows is how we recognise "someone else is already handling this".
  //
  // Keys are claimed BEFORE any money moves, so a duplicate can never reach
  // the ledger. A NULL key conflicts with nothing (Postgres treats NULLs as
  // distinct), so unkeyed transfers are unaffected.
  const claim = await query(
    `INSERT INTO transfers (source_account_id, dest_account_id, amount_minor,
                            status, strategy, idempotency_key)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [sourceAccountId, destAccountId, amountMinor, strategy, idempotencyKey]
  );

  if (claim.rowCount === 0) {
    // Lost the race for this key. The winner is doing the work (or already
    // did) - we return their transfer instead of doing it a second time.
    return replayExistingTransfer(idempotencyKey, startedAt);
  }

  const transfer = claim.rows[0];

  await recordEvent(null, transfer.id, 'transfer.created', {
    amount_minor: amountMinor,
    strategy,
    idempotency_key: idempotencyKey,
  });

  // --- 4. Hand off to the strategy -----------------------------------------
  try {
    const { retries } = await chosen.execute(transfer, { sourceKind: source.kind });

    await recordEvent(null, transfer.id, 'transfer.posted', {
      retries,
      duration_ms: Date.now() - startedAt,
    });

    return {
      transferId: transfer.id,
      status: 'posted',
      reason: null,
      retries,
      replayed: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // --- 5. Record the failure ---------------------------------------------
    // The strategy threw, so its transaction rolled back and no ledger entries
    // exist. We mark the transfer failed on a fresh connection - the strategy
    // transaction is gone, and a failure we cannot explain to the customer is
    // worse than the failure itself.
    const reason = error instanceof TransferError ? error.message : `Unexpected: ${error.message}`;

    await markFailed(null, transfer.id, reason);
    await recordEvent(null, transfer.id, 'transfer.failed', {
      code: error.code ?? 'UNKNOWN',
      reason,
      duration_ms: Date.now() - startedAt,
    });

    return {
      transferId: transfer.id,
      status: 'failed',
      reason,
      retries: 0,
      replayed: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Return the transfer that already owns this idempotency key.
 *
 * One honest caveat: the winning request may still be mid-flight, in which
 * case its status is 'pending' and we report that rather than inventing an
 * outcome. A production system would either poll briefly for it to settle or
 * return 409 and let the caller re-ask - what it must never do is start a
 * second transfer, which is the failure this whole mechanism exists to
 * prevent.
 */
async function replayExistingTransfer(idempotencyKey, startedAt) {
  const { rows } = await query('SELECT * FROM transfers WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);

  const existing = rows[0];

  return {
    transferId: existing.id,
    status: existing.status,
    reason: existing.failure_reason,
    retries: 0,
    replayed: true,
    durationMs: Date.now() - startedAt,
  };
}
