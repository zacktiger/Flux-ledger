// ============================================================================
// POST /api/transfers - the HTTP version of the send-money form.
// ============================================================================
// The UI uses a server action, not this route. This exists so the system can
// be driven from curl, which is how you would actually demonstrate idempotency
// to someone:
//
//   curl -X POST localhost:3000/api/transfers \
//     -H 'content-type: application/json' \
//     -H 'idempotency-key: demo-1' \
//     -d '{"sourceAccountId":"...","destAccountId":"...","amountRupees":10}'
//
// Send it twice. The second response has "replayed": true and the same
// transferId, and no second debit appears on the account.
// ============================================================================
import { executeTransfer, DEFAULT_STRATEGY } from '../../../lib/transfer/index.js';
import { rupeesToPaise } from '../../../lib/money.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const { sourceAccountId, destAccountId, amountRupees, amountMinor, strategy } = body;

  // Accept either rupees (convenient from curl) or paise (exact). Paise wins
  // if both are present, since it is the unit with no rounding question.
  const amount = amountMinor ?? rupeesToPaise(amountRupees);

  if (!sourceAccountId || !destAccountId) {
    return Response.json(
      { error: 'sourceAccountId and destAccountId are required' },
      { status: 400 }
    );
  }

  try {
    const result = await executeTransfer({
      sourceAccountId,
      destAccountId,
      amountMinor: amount,
      strategy: strategy ?? DEFAULT_STRATEGY,
      // The conventional place for this is a header, not the body - it
      // describes the request, not the payment.
      idempotencyKey: request.headers.get('idempotency-key'),
    });

    // 200 even for a rejected transfer: the request was understood and
    // processed, and the answer is "no". 422 would also be defensible; what
    // matters is that the caller can tell the difference, which `status` does.
    return Response.json(result);
  } catch (error) {
    // executeTransfer throws only for malformed requests - unknown account,
    // bad amount, unknown strategy. All of those are the caller's fault.
    return Response.json({ error: error.message, code: error.code ?? null }, { status: 400 });
  }
}
