'use server';
// ============================================================================
// Server actions - the code behind the send-money form.
// ============================================================================
// This runs on the server when the form is submitted. There is no client-side
// JavaScript involved and no fetch call: the form posts, this function runs,
// and the browser is redirected to the result. (An equivalent HTTP endpoint
// lives at app/api/transfers/route.js for anyone who would rather use curl.)
// ============================================================================
import { redirect } from 'next/navigation';
import { executeTransfer, DEFAULT_STRATEGY } from '../lib/transfer/index.js';

export async function sendMoney(formData) {
  const sourceAccountId = formData.get('sourceAccountId');
  const destAccountId = formData.get('destAccountId');
  const strategy = formData.get('strategy') || DEFAULT_STRATEGY;

  // MoneyInput submits integer paise, so there is no decimal string to parse
  // here and no rounding decision to get wrong. It is still validated: the
  // value arrived over the wire and anyone can post whatever they like to a
  // server action.
  const amountMinor = Number(formData.get('amountMinor'));

  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    redirect(`/?error=${encodeURIComponent('Enter an amount greater than zero.')}`);
  }
  if (sourceAccountId === destAccountId) {
    redirect(`/?error=${encodeURIComponent('Pick two different accounts.')}`);
  }

  let result;
  try {
    result = await executeTransfer({
      sourceAccountId,
      destAccountId,
      amountMinor,
      strategy,
      // A fresh key per submission. It does nothing here (each click is a new
      // payment), but it means every transfer in the system has one, so a
      // retry of *this exact request* would be caught rather than duplicated.
      idempotencyKey: `ui-${crypto.randomUUID()}`,
    });
  } catch (error) {
    // executeTransfer only throws for malformed requests - a transfer that is
    // merely rejected (insufficient funds) comes back as a failed result and
    // gets its own page, because a customer needs to see why.
    redirect(`/?error=${encodeURIComponent(error.message)}`);
  }

  // Both posted and failed transfers land on the detail page. That is the
  // point of the timeline: a failure is a story worth showing, not a dead end.
  redirect(`/transfers/${result.transferId}`);
}
