// ============================================================================
// Home: balances, a send-money form, and recent transfers.
// ============================================================================
// A React Server Component. The queries below run on the server during the
// render - there is no API call between this file and the database.
// ============================================================================
import { query } from '../lib/db.js';
import { formatPaise } from '../lib/money.js';
import { STRATEGY_NAMES, STRATEGIES, DEFAULT_STRATEGY } from '../lib/transfer/index.js';
import { sendMoney } from './actions.js';

// Balances change on every transfer, so this page is never cached.
export const dynamic = 'force-dynamic';

/**
 * The four seeded people and their balances.
 *
 * Read from `account_balances`, the view that sums the ledger. Nothing here
 * reads a stored balance, because there is not one to read.
 *
 * Accounts created by the benchmark are excluded - it makes hundreds of them.
 */
async function getAccounts() {
  const { rows } = await query(
    `SELECT ab.account_id, ab.name, ab.balance_minor, u.name AS owner_name
       FROM account_balances ab
       JOIN users u ON u.id = ab.user_id
      WHERE ab.kind = 'user'
        AND u.email NOT LIKE 'bench+%'
      ORDER BY u.name`
  );
  return rows;
}

/** The most recent transfers between the seeded accounts. */
async function getRecentTransfers() {
  const { rows } = await query(
    `SELECT t.id, t.amount_minor, t.status, t.strategy, t.created_at,
            source.name AS source_name,
            dest.name   AS dest_name
       FROM transfers t
       JOIN accounts source ON source.id = t.source_account_id
       JOIN accounts dest   ON dest.id   = t.dest_account_id
      WHERE source.name NOT LIKE 'bench:%'
        AND dest.name   NOT LIKE 'bench:%'
      ORDER BY t.created_at DESC
      LIMIT 12`
  );
  return rows;
}

export default async function HomePage({ searchParams }) {
  // Both queries are independent, so they run at the same time rather than
  // one after the other.
  const [accounts, transfers, params] = await Promise.all([
    getAccounts(),
    getRecentTransfers(),
    searchParams,
  ]);

  const error = params?.error;

  return (
    <>
      {/* ---------------- balances ---------------- */}
      <section className="card">
        <h2>Accounts</h2>
        <p className="card-hint">
          Every figure below is <code>SUM(amount_minor)</code> over the ledger, computed on this
          request. There is no balance column in the schema.
        </p>

        <div className="account-list">
          {accounts.map((account) => (
            <div key={account.account_id} className="account">
              <div className="account-name">{account.owner_name}</div>
              <div className="account-balance">{formatPaise(account.balance_minor)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- send money ---------------- */}
      <section className="card">
        <h2>Send money</h2>
        <p className="card-hint">
          v1 has no auth. Pick who is sending - that is the whole login system.
        </p>

        {error ? <p className="form-error">{error}</p> : null}

        <form action={sendMoney}>
          <div className="form-row">
            <div>
              <label htmlFor="sourceAccountId">From</label>
              <select id="sourceAccountId" name="sourceAccountId" defaultValue={accounts[0]?.account_id}>
                {accounts.map((account) => (
                  <option key={account.account_id} value={account.account_id}>
                    {account.owner_name} ({formatPaise(account.balance_minor)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="destAccountId">To</label>
              <select id="destAccountId" name="destAccountId" defaultValue={accounts[1]?.account_id}>
                {accounts.map((account) => (
                  <option key={account.account_id} value={account.account_id}>
                    {account.owner_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div>
              <label htmlFor="amount">Amount (rupees)</label>
              <input id="amount" name="amount" type="number" step="0.01" min="0.01" defaultValue="10.00" />
            </div>

            <div>
              {/* Exposing the strategy picker in the UI is unusual for a
                  product and deliberate here: it is the thing the project is
                  about, and it lets you watch the timeline change. */}
              <label htmlFor="strategy">Concurrency strategy</label>
              <select id="strategy" name="strategy" defaultValue={DEFAULT_STRATEGY}>
                {STRATEGY_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {STRATEGIES[name].label}
                    {name === 'naive' ? ' - unsafe' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button type="submit">Send</button>
        </form>
      </section>

      {/* ---------------- recent activity ---------------- */}
      <section className="card">
        <h2>Recent transfers</h2>
        <p className="card-hint">Click any row for its event timeline.</p>

        {transfers.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th>Strategy</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td className="faint">
                    <a href={`/transfers/${transfer.id}`}>
                      {new Date(transfer.created_at).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </a>
                  </td>
                  <td>
                    <a href={`/transfers/${transfer.id}`}>{transfer.source_name}</a>
                  </td>
                  <td>{transfer.dest_name}</td>
                  <td className="mono faint">{transfer.strategy}</td>
                  <td>
                    <span className={`pill pill-${transfer.status}`}>{transfer.status}</span>
                  </td>
                  <td className="amount">{formatPaise(transfer.amount_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
