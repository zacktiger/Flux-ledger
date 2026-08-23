-- ============================================================================
-- Seed data
-- ============================================================================
-- v1 has no auth (deliberately - see README). We seed four people and the UI
-- lets you switch between them with a dropdown.
--
-- Note how the four users get their opening balance: NOT by setting a balance
-- column (there is not one), but by moving money out of a system "mint"
-- account with real transfers and real ledger entries. After this file runs,
-- the mint account sits at -4000 rupees and every rupee in the system is
-- accounted for. `SELECT * FROM ledger_invariant` still reports ok = true.
-- ============================================================================

-- The mint. The origin of all money in this system, and the only account
-- allowed to hold a negative balance.
INSERT INTO accounts (name, kind) VALUES ('Flux Mint', 'system');

-- Four people, each with one account.
WITH new_users AS (
  INSERT INTO users (name, email) VALUES
    ('Asha Menon',    'asha@flux.test'),
    ('Bilal Ahmed',   'bilal@flux.test'),
    ('Chitra Rao',    'chitra@flux.test'),
    ('Dev Sharma',    'dev@flux.test')
  RETURNING id, name
)
INSERT INTO accounts (user_id, name, kind)
SELECT id, name || ' - Everyday', 'user' FROM new_users;


-- ----------------------------------------------------------------------------
-- Fund each user with 1,000 rupees (100,000 paise) from the mint.
--
-- Done in a loop so the mechanics stay obvious: one transfer row, then the two
-- ledger entries that always accompany it (one negative, one positive, summing
-- to zero).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  mint_id      UUID;
  target       RECORD;
  new_transfer UUID;
  opening      BIGINT := 100000;  -- 1,000 rupees in paise
BEGIN
  SELECT id INTO mint_id FROM accounts WHERE kind = 'system' LIMIT 1;

  FOR target IN SELECT id, name FROM accounts WHERE kind = 'user' ORDER BY name
  LOOP
    -- 1. The intent.
    INSERT INTO transfers (source_account_id, dest_account_id, amount_minor,
                           status, strategy, settled_at)
    VALUES (mint_id, target.id, opening, 'posted', 'seed', now())
    RETURNING id INTO new_transfer;

    -- 2. The money: a matching debit and credit that sum to zero.
    INSERT INTO ledger_entries (transfer_id, account_id, amount_minor) VALUES
      (new_transfer, mint_id,   -opening),   -- debit  the mint
      (new_transfer, target.id,  opening);   -- credit the user

    -- 3. The story, for the timeline UI.
    INSERT INTO events (transfer_id, type, detail) VALUES
      (new_transfer, 'transfer.created',
       jsonb_build_object('note', 'Opening balance', 'amount_minor', opening)),
      (new_transfer, 'ledger.posted',
       jsonb_build_object('entries', 2)),
      (new_transfer, 'transfer.posted',
       jsonb_build_object('note', 'Funded from ' || 'Flux Mint'));
  END LOOP;
END;
$$;
