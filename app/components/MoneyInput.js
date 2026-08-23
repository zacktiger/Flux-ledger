'use client';
// ============================================================================
// A money input that cannot produce a wrong amount.
// ============================================================================
// `<input type="number">` is the obvious choice and it is the wrong one. It
// accepts `1e5`, `10.999`, `-5`, and `+10`, it lets a paste of "₹1,000.00"
// through in some browsers, and different browsers disagree about what
// `valueAsNumber` returns for a partially typed value. All of that then has to
// be untangled on the server, where a mistake is a wrong debit.
//
// This component takes the opposite approach: it is a *text* input that
// refuses to hold anything that is not a valid rupee amount, and it submits
// integer paise rather than a decimal string, so the server never parses a
// float at all. The paise figure is shown to the user, because in a system
// where the ledger is denominated in paise, the exact integer being sent is
// worth seeing.
// ============================================================================
import { useState } from 'react';
import { rupeesToPaise } from '../../lib/money.js';

/**
 * Strip anything that is not part of a plain decimal amount.
 *
 * Runs on every keystroke, so it has to tolerate half-typed input: "10." is
 * not a valid number but it is a valid thing to be in the middle of typing,
 * and clearing it out from under the user would make the field unusable.
 */
function sanitize(raw) {
  // Currency symbols, thousands separators, spaces, letters, and the `e` of
  // scientific notation all disappear here.
  let cleaned = raw.replace(/[^\d.]/g, '');

  // Keep only the first decimal point; "1.2.3" becomes "1.23".
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned =
      cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }

  // Paise are the smallest unit that exists, so a third decimal place is not a
  // rounding question - it is a quantity this system cannot represent. Refuse
  // it at the input rather than silently rounding it later.
  const [whole, fraction] = cleaned.split('.');
  if (fraction !== undefined) {
    cleaned = `${whole}.${fraction.slice(0, 2)}`;
  }

  return cleaned;
}

export function MoneyInput({ name = 'amountMinor', defaultRupees = '10.00', label = 'Amount' }) {
  const [text, setText] = useState(defaultRupees);

  // "" and "." are mid-typing states, not amounts. Treat them as zero so the
  // hidden field always carries a valid integer.
  const amountMinor = text === '' || text === '.' ? 0 : rupeesToPaise(text);
  const isValid = Number.isInteger(amountMinor) && amountMinor > 0;

  return (
    <div>
      <label htmlFor="money-input">
        {label} (rupees)
      </label>

      {/* type="text" with inputMode="decimal" gets the numeric keypad on
          mobile without inheriting type="number" parsing quirks. */}
      <input
        id="money-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(sanitize(event.target.value))}
        // Select the whole amount on focus. Without this, clicking into a
        // prefilled "10.00" and typing does nothing at all: the value already
        // has two decimals, so every new keystroke is correctly rejected as a
        // third one, and the field feels broken even though it is behaving.
        onFocus={(event) => event.target.select()}
        aria-describedby="money-input-hint"
      />

      {/* What actually gets submitted. The server receives an integer and
          never has to parse a decimal string. */}
      <input type="hidden" name={name} value={amountMinor} />

      <p id="money-input-hint" className="input-hint">
        {isValid ? (
          <>
            sends <strong>{amountMinor.toLocaleString('en-IN')}</strong> paise
          </>
        ) : (
          <span className="input-hint-warn">enter an amount above zero</span>
        )}
      </p>
    </div>
  );
}
