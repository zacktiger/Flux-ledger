// ============================================================================
// Strategy 2 of 4: pessimistic row-level locking (SELECT ... FOR UPDATE)
// ============================================================================
// The fix is one line: before reading the balance, take an exclusive lock on
// the source account row.
//
//     SELECT id FROM accounts WHERE id = $1 FOR UPDATE
//
// Any other transaction that runs that same statement now *blocks* until this
// transaction commits. The read-check-write sequence becomes one indivisible
// step per account, so the stale-read window from the naive strategy simply
// does not exist. Transfers queue up and run one at a time.
//
// Note that we lock the `accounts` row even though the money lives in
// `ledger_entries`. The account row is standing in as a mutex for "the balance
// of this account" - there is no single ledger row to lock, because the
// balance is a sum over many of them, and rows that do not exist yet cannot be
// locked.
//
// Cost: throughput. Transfers out of one hot account are fully serialised, and
// a slow transaction holds the lock for everyone behind it.
// ============================================================================
import { withTransaction } from '../db.js';
import {
  getBalanceMinor,
  postLedgerEntries,
  markPosted,
  recordEvent,
  assertSufficientFunds,
} from './shared.js';

export const forUpdate = {
  name: 'for-update',
  label: 'SELECT ... FOR UPDATE',
  description:
    'Takes an exclusive row lock on the source account before reading the ' +
    'balance, so concurrent transfers out of that account run one at a time.',

  async execute(transfer, { sourceKind }) {
    await withTransaction(async (client) => {
      // --- The lock --------------------------------------------------------
      // Everything below runs with this row held. Only the source is locked:
      // it is the only account that can be overdrawn, and locking the
      // destination too would halve our throughput for no benefit.
      //
      // (If a future feature needed both rows locked, they would have to be
      // locked in a consistent order - e.g. sorted by id - or two transfers in
      // opposite directions would deadlock against each other.)
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [
        transfer.source_account_id,
      ]);

      await recordEvent(client, transfer.id, 'lock.acquired', {
        account_id: transfer.source_account_id,
        mode: 'FOR UPDATE',
      });

      // From here on this is identical to the naive strategy - the difference
      // is entirely that nobody else can be in this section at the same time.
      const balanceMinor = await getBalanceMinor(client, transfer.source_account_id);

      await recordEvent(client, transfer.id, 'balance.checked', {
        balance_minor: balanceMinor,
        required_minor: transfer.amount_minor,
        strategy: 'for-update',
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
        strategy: 'for-update',
      });

      // COMMIT (inside withTransaction) is what releases the lock and lets the
      // next transfer in.
    });

    // Waiting for a lock is not a retry - the transaction only ever runs once.
    return { retries: 0 };
  },
};
