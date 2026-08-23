// ============================================================================
// Money formatting. All amounts in this project are integer paise.
// ============================================================================
// Rule: money crosses into this file to be *displayed* and comes out of it to
// be *stored*, and it is an integer everywhere in between. No float ever
// touches an amount.
// ============================================================================

/** 1 rupee = 100 paise. */
export const PAISE_PER_RUPEE = 100;

/**
 * Rupees (as typed by a human, e.g. "10.50") -> integer paise.
 * Math.round is what stops 10.10 * 100 = 1009.9999999999999 from truncating
 * to 1009 and quietly losing a paisa.
 */
export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * PAISE_PER_RUPEE);
}

/** Integer paise -> a plain decimal number of rupees, for display only. */
export function paiseToRupees(paise) {
  return paise / PAISE_PER_RUPEE;
}

/**
 * Integer paise -> a display string, e.g. -84000 becomes "-₹840.00".
 * The sign goes before the symbol, which is how banks print it.
 */
export function formatPaise(paise) {
  const negative = paise < 0;
  const absolute = Math.abs(paise);

  const formatted = (absolute / PAISE_PER_RUPEE).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return `${negative ? '-' : ''}₹${formatted}`;
}
