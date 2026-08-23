-- ============================================================================
-- Flux - double-entry ledger schema
-- ============================================================================
-- The single rule this schema exists to enforce:
--
--     Money is never stored. Money is derived.
--
-- There is no `balance` column anywhere in this file. A balance is the SUM of
-- every ledger entry ever written for an account. That makes it impossible for
-- a balance to drift away from the transactions that produced it, which is the
-- most common bug in hand-rolled wallet systems.
--
-- All amounts are BIGINT *paise* (1 rupee = 100 paise). Never floats - in
-- binary floating point 0.1 + 0.2 is not 0.3, and that error compounds over
-- millions of rows.
-- ============================================================================

-- gen_random_uuid() lives here on Postgres < 13; harmless to request anyway.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ----------------------------------------------------------------------------
-- users - deliberately tiny. v1 has no auth; we seed four people and let the
-- UI switch between them with a dropdown.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- accounts - the things money moves between.
--
-- kind = 'system' marks accounts that are allowed to go negative. Every rupee
-- in the system has to come from somewhere: to give a user 1000 rupees we move
-- it OUT of the system mint account, which leaves that account at -1000. That
-- is correct double-entry, not a bug. User accounts may never go below zero.
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL for system accounts
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'system')),

  -- `version` is used by exactly one of our four transfer strategies (the
  -- optimistic one). It is meaningless to the other three. It lives here rather
  -- than in a side table so the optimistic strategy can bump it in the same
  -- statement it uses to detect a conflict.
  version    BIGINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A user account may only exist if it belongs to a user.
  CONSTRAINT user_accounts_have_owner
    CHECK (kind = 'system' OR user_id IS NOT NULL)
);

CREATE INDEX accounts_user_id_idx ON accounts(user_id);


-- ----------------------------------------------------------------------------
-- transfers - the *intent*. "Asha wants to send 10 rupees to Bilal."
--
-- A transfer row is the envelope. It says what was requested and how it ended
-- up. It is NOT the money itself - the money is in ledger_entries. A transfer
-- can be `failed` and still have a row here, which is exactly what you want
-- when a customer asks what happened to their payment.
-- ----------------------------------------------------------------------------
CREATE TABLE transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id UUID NOT NULL REFERENCES accounts(id),
  dest_account_id   UUID NOT NULL REFERENCES accounts(id),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),

  --  pending -> the row is claimed, entries not written yet
  --  posted  -> ledger entries written, money has moved
  --  failed  -> nothing was written to the ledger; failure_reason says why
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'posted', 'failed')),

  -- Which concurrency-control strategy executed this transfer. Recorded so the
  -- benchmark can slice results, and so the UI can show it.
  strategy          TEXT NOT NULL,

  -- Idempotency: the caller unique key for this request. UNIQUE is the whole
  -- mechanism - two concurrent requests carrying the same key cannot both
  -- insert, so exactly one of them does the work and the other replays the
  -- result. NULL is allowed and NULLs never collide in Postgres, so unkeyed
  -- transfers are unaffected.
  idempotency_key   TEXT UNIQUE,

  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ,

  -- You cannot send money to yourself. Without this, a self-transfer would net
  -- to zero but still write two confusing ledger rows.
  CONSTRAINT no_self_transfer CHECK (source_account_id <> dest_account_id)
);

CREATE INDEX transfers_source_idx  ON transfers(source_account_id);
CREATE INDEX transfers_dest_idx    ON transfers(dest_account_id);
CREATE INDEX transfers_created_idx ON transfers(created_at DESC);


-- ----------------------------------------------------------------------------
-- ledger_entries - the money. Append-only.
--
-- Every transfer writes exactly two rows here: one negative (the debit, money
-- leaving) and one positive (the credit, money arriving). They always sum to
-- zero, which is what makes this double-entry.
--
-- `amount_minor` is signed. A debit of 10 rupees is -1000, the matching credit
-- is +1000. Summing every row in the whole table must give exactly 0 - if it
-- ever does not, money was created or destroyed and something is badly wrong.
-- ----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  transfer_id  UUID NOT NULL REFERENCES transfers(id) ON DELETE RESTRICT,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

  -- Signed. Negative = debit (money out), positive = credit (money in).
  -- Zero-amount entries are meaningless, so they are rejected.
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The index that makes balance lookups fast. Balances are SUM(amount_minor)
-- filtered by account_id, so this is the index that query rides on.
CREATE INDEX ledger_entries_account_idx  ON ledger_entries(account_id);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries(transfer_id);


-- ----------------------------------------------------------------------------
-- Append-only, enforced by the database - not by application code.
--
-- Application-level rules get bypassed: by a migration, by a psql session at
-- 2am, by the next developer. A trigger cannot be bypassed by anything short of
-- dropping the trigger, which shows up in a diff.
-- ----------------------------------------------------------------------------
CREATE FUNCTION ledger_entries_are_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % is not permitted (entry id %)',
    TG_OP, COALESCE(OLD.id, NEW.id)
    USING HINT = 'To reverse a posted entry, write a new compensating entry.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_immutable();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_immutable();

-- TRUNCATE deserves its own trigger. Row-level triggers do not fire for it -
-- it deallocates the whole table without ever looking at a row - so without
-- this, `TRUNCATE ledger_entries` would silently erase every transaction in
-- the system and the two triggers above would never run.
--
-- This is why the benchmark creates fresh accounts for each run instead of
-- wiping the ledger between them: with this trigger in place there is no way
-- to un-write history, which is the entire point of an append-only table.
CREATE FUNCTION ledger_entries_no_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: TRUNCATE is not permitted'
    USING HINT = 'To start over, drop and recreate the database (npm run db:reset).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_no_truncate();


-- ----------------------------------------------------------------------------
-- events - a human-readable audit trail of what happened during a transfer.
--
-- This is what the transaction detail screen renders as a timeline. It is
-- written *during* the transfer, so it captures things the final row cannot
-- show you: how many times an optimistic attempt lost a race, why a transfer
-- was rejected, how long the whole thing took.
-- ----------------------------------------------------------------------------
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,

  -- e.g. 'transfer.created', 'balance.checked', 'attempt.conflict',
  --      'ledger.posted', 'transfer.posted', 'transfer.failed'
  type        TEXT NOT NULL,

  -- Free-form structured detail. jsonb rather than columns because every event
  -- type carries different fields, and this table is read far more than it is
  -- queried by field.
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_transfer_idx ON events(transfer_id, id);


-- ============================================================================
-- Derived views. This is where "balances are never stored" becomes real.
-- ============================================================================

-- The balance of every account, computed from the ledger every time you ask.
-- LEFT JOIN so a brand-new account with no entries reports 0 rather than
-- vanishing from the result.
CREATE VIEW account_balances AS
SELECT
  a.id                                      AS account_id,
  a.user_id,
  a.name,
  a.kind,
  COALESCE(SUM(le.amount_minor), 0)::BIGINT AS balance_minor,
  COUNT(le.id)                              AS entry_count
FROM accounts a
LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY a.id, a.user_id, a.name, a.kind;


-- The invariant, as a query you can run at any moment - including while the
-- benchmark is hammering the database.
--
--   global_sum_minor      must be 0  (no money created or destroyed, ever)
--   unbalanced_transfers  must be 0  (every transfer own entries sum to 0)
--   overdrawn_accounts    must be 0  (no *user* account below zero)
--
-- If `ok` is false, the ledger is corrupt. That is the number the benchmark
-- reports for each strategy.
CREATE VIEW ledger_invariant AS
WITH
  global AS (
    SELECT COALESCE(SUM(amount_minor), 0)::BIGINT AS global_sum_minor
    FROM ledger_entries
  ),
  per_transfer AS (
    SELECT COUNT(*)::BIGINT AS unbalanced_transfers
    FROM (
      SELECT transfer_id
      FROM ledger_entries
      GROUP BY transfer_id
      HAVING SUM(amount_minor) <> 0
    ) bad
  ),
  overdrawn AS (
    -- System accounts are *supposed* to be negative (they are the source of
    -- all money), so only user accounts are checked here.
    SELECT
      COUNT(*)::BIGINT                                  AS overdrawn_accounts,
      COALESCE(SUM(LEAST(balance_minor, 0)), 0)::BIGINT AS total_overdraft_minor
    FROM account_balances
    WHERE kind = 'user' AND balance_minor < 0
  )
SELECT
  global.global_sum_minor,
  per_transfer.unbalanced_transfers,
  overdrawn.overdrawn_accounts,
  overdrawn.total_overdraft_minor,
  (global.global_sum_minor = 0
   AND per_transfer.unbalanced_transfers = 0
   AND overdrawn.overdrawn_accounts = 0) AS ok
FROM global, per_transfer, overdrawn;
