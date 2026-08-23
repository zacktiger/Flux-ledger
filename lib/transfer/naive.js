// ============================================================================
// Strategy 1 of 4: naive read-modify-write.  ** DELIBERATELY BROKEN **
// ============================================================================
// This is the version almost everyone writes first:
//
//     1. read the balance
//     2. is it enough?  yes
//     3. write the entries
//
// It is wrong, and the benchmark exists to show exactly how wrong. Between
// step 1 and step 3 there is a window in which *any number* of other requests
// can run their own step 1 and read the same balance. They all see 1,000
// rupees, they all conclude they can afford 10 rupees, and they all write.
// The account goes negative even though every single request checked first.
//
// Note what this file does NOT do: it never opens a transaction and never
// takes a lock. Each query runs on its own, autocommitted. Wrapping these
// statements in a plain BEGIN/COMMIT would not fix it either - the default
// READ COMMITTED isolation level would still let every transaction read the
// same stale balance. Preventing this needs a lock or a conflict check, which
// is what the next three strategies add.
// ============================================================================
import { withClient } from '../db.js';
import {
  getBalanceMinor,
  postLedgerEntries,
  markPosted,
  recordEvent,
  assertSufficientFunds,
  sleep,
} from './shared.js';

export const naive = {
  name: 'naive',
  label: 'naive read-modify-write',
  description:
    'Reads the balance, checks it, then writes. No transaction, no lock. ' +
    'The gap between the read and the write is the bug.',

  async execute(transfer, { sourceKind }) {
    await withClient(async (client) => {
      // --- 1. READ ---------------------------------------------------------
      const balanceMinor = await getBalanceMinor(client, transfer.source_account_id);

      await recordEvent(client, transfer.id, 'balance.checked', {
        balance_minor: balanceMinor,
        required_minor: transfer.amount_minor,
        strategy: 'naive',
      });

      // --- 2. CHECK --------------------------------------------------------
      // This check is honest and it still does not save us, because by the
      // time step 3 runs the balance it was based on may be long gone.
      assertSufficientFunds({
        balanceMinor,
        amountMinor: transfer.amount_minor,
        sourceKind,
      });

      // --- THE RACE WINDOW -------------------------------------------------
      // Real applications do work here: fraud scoring, an FX lookup, a
      // partner API call. Every millisecond of it widens the window. Set
      // NAIVE_THINK_MS to simulate that latency and watch the overdraft grow.
      // It defaults to 0, so the benchmark numbers in the README come from
      // real contention and not from an artificial delay.
      const thinkMs = Number(process.env.NAIVE_THINK_MS ?? 0);
      if (thinkMs > 0) await sleep(thinkMs);

      // --- 3. WRITE --------------------------------------------------------
      await postLedgerEntries(client, transfer);
      await markPosted(client, transfer.id);

      await recordEvent(client, transfer.id, 'ledger.posted', {
        entries: 2,
        strategy: 'naive',
      });
    });

    // The naive strategy never retries - it never notices anything went wrong.
    return { retries: 0 };
  },
};
