'use client';
// ============================================================================
// A submit button that disables itself while the transfer is in flight.
// ============================================================================
// This is deliberately NOT optimistic UI. On a money transfer, showing
// "sent" before the server has confirmed it is a lie you may have to retract,
// and a user who sees a success that then reverses is a user who taps again.
// The honest states are: idle, in flight, and whatever the server actually
// decided.
//
// Disabling on submit is also the first line of defence against double
// submission. The second line is the idempotency key, which catches the
// duplicates this cannot - a second browser tab, an impatient refresh, a
// mobile client retrying on timeout. Neither replaces the other.
// ============================================================================
import { useFormStatus } from 'react-dom';

export function SubmitButton({ idleLabel = 'Send', pendingLabel = 'Sending...' }) {
  // useFormStatus reports on the nearest <form> ancestor, which is why this
  // has to be its own component rather than living in the page that renders
  // the form - a component cannot read the status of a form it renders itself.
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
