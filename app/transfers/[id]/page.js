// ============================================================================
// Transaction detail - the one screen v1 ships.
// ============================================================================
// Three things, in order of how much they matter:
//
//   1. the double-entry pair: the two ledger rows that ARE this transfer
//   2. the event timeline: what the system did, in order, including retries
//   3. the facts: ids, strategy, idempotency key
//
// Every row on this page is real data written during the transfer. Nothing is
// reconstructed or inferred after the fact.
// ============================================================================
import { notFound } from 'next/navigation';
import { query } from '../../../lib/db.js';
import { formatPaise } from '../../../lib/money.js';

export const dynamic = 'force-dynamic';

/** The transfer, with the names of both sides resolved. */
async function getTransfer(id) {
  const { rows } = await query(
    `SELECT t.*,
            source.name       AS source_name,
            dest.name         AS dest_name,
            source_owner.name AS source_owner,
            dest_owner.name   AS dest_owner
       FROM transfers t
       JOIN accounts source     ON source.id = t.source_account_id
       JOIN accounts dest       ON dest.id   = t.dest_account_id
       LEFT JOIN users source_owner ON source_owner.id = source.user_id
       LEFT JOIN users dest_owner   ON dest_owner.id   = dest.user_id
      WHERE t.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** The ledger entries this transfer wrote. Always zero or two of them. */
async function getEntries(transferId) {
  const { rows } = await query(
    `SELECT le.id, le.amount_minor, le.created_at, a.name AS account_name
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
      WHERE le.transfer_id = $1
      ORDER BY le.amount_minor`,   // debit (negative) first, then the credit
    [transferId]
  );
  return rows;
}

/** The timeline, oldest first. Ordered by id, not created_at: events written
 *  in the same millisecond would otherwise come back in an arbitrary order. */
async function getEvents(transferId) {
  const { rows } = await query(
    `SELECT id, type, detail, created_at
       FROM events
      WHERE transfer_id = $1
      ORDER BY id`,
    [transferId]
  );
  return rows;
}

/** Colour the timeline dot by what kind of event it is. */
function dotClass(type) {
  if (type.endsWith('.failed')) return 'timeline-dot timeline-dot-failed';
  if (type.endsWith('.conflict')) return 'timeline-dot timeline-dot-conflict';
  if (type.endsWith('.posted')) return 'timeline-dot timeline-dot-posted';
  return 'timeline-dot';
}

export default async function TransferDetailPage({ params }) {
  const { id } = await params;

  const transfer = await getTransfer(id);
  if (!transfer) notFound();

  const [entries, events] = await Promise.all([getEntries(id), getEvents(id)]);

  // Retries are not stored on the transfer row - they are counted from the
  // conflict events, which is the only place they were ever recorded.
  const conflicts = events.filter((event) => event.type === 'attempt.conflict').length;

  return (
    <>
      <a className="back-link" href="/">
        &larr; All transfers
      </a>

      {/* ---------------- headline ---------------- */}
      <div className="detail-header">
        <span className={`pill pill-${transfer.status}`}>{transfer.status}</span>
        <div className="detail-amount">{formatPaise(transfer.amount_minor)}</div>
        <div className="detail-route">
          {transfer.source_owner ?? transfer.source_name} &rarr;{' '}
          {transfer.dest_owner ?? transfer.dest_name}
        </div>
        {transfer.failure_reason ? (
          <p className="form-error" style={{ marginTop: 14 }}>
            {transfer.failure_reason}
          </p>
        ) : null}
      </div>

      {/* ---------------- the double entry ---------------- */}
      <section className="card">
        <h2>Ledger entries</h2>
        <p className="card-hint">
          {entries.length === 2
            ? 'Two rows, summing to zero. This pair is the money - the transfer row above is only the instruction.'
            : 'None. This transfer never touched the ledger, which is what "failed" means here.'}
        </p>

        {entries.length === 0 ? (
          <p className="empty">No entries were written.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Account</th>
                <th>Direction</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono faint">#{entry.id}</td>
                  <td>{entry.account_name}</td>
                  <td className="dim">{entry.amount_minor < 0 ? 'debit' : 'credit'}</td>
                  <td
                    className="amount"
                    style={{ color: entry.amount_minor < 0 ? 'var(--negative)' : 'var(--positive)' }}
                  >
                    {formatPaise(entry.amount_minor)}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="faint">
                  sum
                </td>
                <td className="amount faint">
                  {formatPaise(entries.reduce((total, entry) => total + entry.amount_minor, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- the timeline ---------------- */}
      <section className="card">
        <h2>Timeline</h2>
        <p className="card-hint">
          Written to the <code>events</code> table while the transfer ran
          {conflicts > 0
            ? ` - including ${conflicts} attempt${conflicts === 1 ? '' : 's'} that lost a race and were retried.`
            : '.'}
        </p>

        <ul className="timeline">
          {events.map((event) => (
            <li key={event.id} className="timeline-item">
              <span className={dotClass(event.type)} />
              <span className="timeline-type">{event.type}</span>
              <span className="timeline-time">
                {new Date(event.created_at).toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
              {Object.keys(event.detail).length > 0 ? (
                <pre className="timeline-detail">{JSON.stringify(event.detail, null, 2)}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------- the boring but necessary bits ---------------- */}
      <section className="card">
        <h2>Details</h2>
        <div className="facts" style={{ marginTop: 16 }}>
          <div>
            <div className="fact-label">Transfer id</div>
            <div className="fact-value">{transfer.id}</div>
          </div>
          <div>
            <div className="fact-label">Strategy</div>
            <div className="fact-value">{transfer.strategy}</div>
          </div>
          <div>
            <div className="fact-label">Idempotency key</div>
            <div className="fact-value">{transfer.idempotency_key ?? '-'}</div>
          </div>
          <div>
            <div className="fact-label">Created</div>
            <div className="fact-value">{new Date(transfer.created_at).toISOString()}</div>
          </div>
          <div>
            <div className="fact-label">Settled</div>
            <div className="fact-value">
              {transfer.settled_at ? new Date(transfer.settled_at).toISOString() : '-'}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
