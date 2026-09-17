# Flux — reading guide

A manual for reading this codebase in the order it was designed to be read.

Flux is not a wallet product. It is a **money-movement correctness demo**: one benchmark table
showing that four concurrency-control strategies behave differently when 200 transfers hit one
account at the same instant. Read it with that goal in mind and the file layout stops looking
arbitrary.

Total reading surface is about 2,300 lines, most of it comments. Budget ~45 minutes for the
full pass, ~10 minutes for the short one.

---

## The short pass (if you only have ten minutes)

1. `docs/benchmark-results.md` — the result. See what the project claims.
2. `lib/transfer/naive.js` — the bug that makes the result interesting.
3. `lib/transfer/for-update.js` — the one-line fix.
4. `db/001_schema.sql` lines 109–185 — why the ledger cannot lie.

Then stop. Everything else is machinery around those four ideas.

---

## The full pass

### Stage 0 — What is being claimed

| Read | Why |
|---|---|
| [README.md](../README.md) | The pitch, the benchmark table, and the "which one would I ship?" argument. |
| [docs/benchmark-results.md](benchmark-results.md) | The generated numbers. Note: **generated** — the source of truth is `scripts/bench.mjs`, not this file. |

The headline to hold onto: 200 transfers × ₹10 against a ₹1,000 balance. A correct system posts
exactly **100** and rejects **100**. `naive` posts more than 100. Those extra rupees never existed.

---

### Stage 1 — The data model (30% of the value, in one file)

**Read [db/001_schema.sql](../db/001_schema.sql) top to bottom.** It is 270 lines and it carries
the whole design argument. In order:

| Lines | What | The idea |
|---|---|---|
| 1–20 | Header | *Money is never stored, money is derived.* There is no `balance` column in this file, on purpose. |
| 26–61 | `users`, `accounts` | `kind = 'system'` marks accounts allowed to go negative — the mint is where all money originates. `version` on `accounts` exists only for the optimistic strategy. |
| 72–106 | `transfers` | The **intent**, not the money. "Asha wants to send ₹10." A row survives here even when the transfer fails, which is what you need when a customer asks what happened. `idempotency_key` is UNIQUE — remember that, it becomes the entire replay guard later. |
| 120–135 | `ledger_entries` | The **money**. Two rows per transfer: a signed debit (−1000) and a matching credit (+1000). They sum to zero by construction. |
| 138–185 | The three triggers | Append-only, enforced by the database, not by application code. `BEFORE UPDATE`, `BEFORE DELETE`, and — the one people forget — `BEFORE TRUNCATE FOR EACH STATEMENT`, because row-level triggers never fire on TRUNCATE. |
| 190–213 | `events` | The per-transfer timeline the UI renders. |
| 216–237 | `account_balances` view | `SUM(amount_minor)` grouped by account. This view *is* the balance. |
| 238–270 | `ledger_invariant` view | Query it at any moment to assert correctness. |

Then skim [db/002_seed.sql](../db/002_seed.sql) — four users, a mint, opening balances.

**Two invariants that get conflated. Keep them apart:**

| Invariant | Broken by `naive`? | Enforced by |
|---|---|---|
| `SUM(amount_minor) = 0` across the whole table — no money created or destroyed | **No** | double-entry itself |
| No `kind = 'user'` account below zero | **Yes** | concurrency control |

Even the broken strategy writes a matching debit and credit, so double-entry always holds. What
`naive` breaks is the *business rule*. `ledger_invariant` reports both separately.

**Consequence to notice now, so it isn't confusing later:** because the ledger genuinely cannot be
wiped, the benchmark cannot reset between runs. It creates a fresh funded account pair per
strategy instead. Only `npm run db:reset` (which drops the schema) clears data.

---

### Stage 2 — The two primitives

Small files. Read both before any transfer code.

**[lib/money.js](../lib/money.js)** (40 lines) — every amount is an integer number of paise.
`rupeesToPaise` uses `Math.round` because `10.10 * 100` is `1009.9999999999999` in binary floating
point, and truncating that silently loses a paisa. No float ever touches an amount; money enters
this file to be displayed and leaves it to be stored.

**[lib/db.js](../lib/db.js)** (87 lines) — four things worth pausing on:

- `pg.types.setTypeParser(20, ...)` at the top. node-postgres returns BIGINT as a **string** by
  default. Without this line every amount comparison silently becomes a *string* comparison, and
  those bugs are subtle and awful.
- The pool is stashed on `globalThis` so Next.js hot reload doesn't leak a pool per save.
- `max: DB_POOL_MAX ?? 40` is the real ceiling on how many transfers are concurrent *inside
  Postgres* during the benchmark. The other 160 queue in the client. Change it and the benchmark
  numbers change.
- `withTransaction(fn, { isolationLevel })` — the isolation level is a parameter, which is the
  hinge the `serializable` strategy turns on.

---

### Stage 3 — The orchestrator

**[lib/transfer/index.js](../lib/transfer/index.js)** (189 lines). One function, `executeTransfer`,
owns everything that does *not* depend on the strategy. Read its five numbered sections in order:

1. **Validate** — cheap checks before touching the DB. The schema enforces these too; these exist
   to produce a readable message instead of a constraint violation.
2. **Look up accounts** — needed for `kind`, because system accounts may go negative.
3. **Claim the idempotency key** — one `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
   RETURNING *`. That single statement *is* the whole idempotency mechanism. Two identical
   requests race; only one can insert; the loser gets zero rows back and calls
   `replayExistingTransfer` instead of moving money a second time. The key is claimed **before**
   any money moves, so a duplicate can never reach the ledger. A NULL key conflicts with nothing
   (Postgres treats NULLs as distinct), so unkeyed transfers are unaffected.
4. **Hand off to the strategy** — `chosen.execute(transfer, { sourceKind })`. The strategy receives
   an already-created transfer row and is responsible for exactly one thing: moving the money
   without letting a concurrent transfer corrupt the balance.
5. **Record the outcome.**

**The error contract, and it is easy to get backwards:**

- A strategy **throws** on business failure (`TransferError`) or conflict exhaustion. Its
  transaction rolls back; `executeTransfer` then marks the transfer `failed` on a *fresh*
  connection — the strategy's transaction is gone.
- `executeTransfer` **returns** `{ status: 'failed' }` for that case. It **throws** only for
  malformed requests: unknown account, bad amount, unknown strategy.

Both callers (the server action and the API route) depend on that split. "Insufficient funds" is
an answer, not an error.

---

### Stage 4 — The shared mechanics

**[lib/transfer/shared.js](../lib/transfer/shared.js)** (177 lines). Everything identical across
strategies lives here, which is what keeps the four strategy files short enough to read side by
side. Skim the whole file, then dwell on three functions:

- **`getBalanceMinor`** — the query the project is built around. A balance is never read from a
  column; it is summed from the ledger. Crucially, `client` may be a pooled connection *or* a
  transaction, and **the isolation level of the surrounding transaction is what decides whether
  this read is safe.** That single fact is the difference between three of the four strategies.
- **`recordEvent(client, ...)`** — pass a client and the event lives inside that transaction, so
  it rolls back with everything else. Pass `null` and it goes out on its own connection. Conflict
  events **must** pass `null`: they describe an attempt that was just rolled back, so writing them
  inside that transaction would erase them. This is why the UI timeline can show retries at all.
- **`retryOnConflict`** — up to 25 attempts, randomised exponential backoff. Read the comment on
  the jitter: without it, every loser of a race wakes at the same moment and collides again — the
  retries synchronise instead of spreading out.

Also here: `assertSufficientFunds`, which exempts `kind === 'system'`. The mint is *supposed* to
sit negative.

---

### Stage 5 — The four strategies (the payoff)

Read these **in this exact order**. Each is an answer to the previous one's problem, and they are
written to be diffed against each other — the shared scaffolding is deliberately identical, so the
only thing that differs on screen is the correctness mechanism.

#### 1. [lib/transfer/naive.js](../lib/transfer/naive.js) — deliberately broken

Read the balance, check it, write the entries. No transaction, no lock; each query autocommits on
its own. Between the read and the write, any number of other requests run their own read, all see
₹1,000, all conclude they can afford ₹10, and all write.

Two things the file's header makes explicit and that are worth internalising:

- Wrapping these statements in a plain `BEGIN`/`COMMIT` would **not** fix it. Default
  `READ COMMITTED` isolation still lets every transaction read the same stale balance.
- `NAIVE_THINK_MS` widens the race window on purpose (fraud scoring, an FX call — real work goes
  in that gap). It defaults to `0`, so the README numbers come from real contention, not an
  artificial delay.

**Do not fix this file.** Its failure is the headline result of the entire project.

#### 2. [lib/transfer/for-update.js](../lib/transfer/for-update.js) — pessimistic locking

The fix is one statement: `SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, before reading the
balance. Any other transaction running that statement now *blocks* until this one commits, so
read-check-write becomes indivisible per account.

Note the subtlety: we lock the `accounts` row even though the money lives in `ledger_entries`. The
account row is standing in as a **mutex for "the balance of this account"** — there is no single
ledger row to lock, because the balance is a sum over many, and rows that don't exist yet cannot
be locked. Only the source is locked; the destination cannot be overdrawn.

Cost: throughput. Transfers out of one hot account fully serialise. `retries: 0` always — waiting
for a lock is not a retry.

#### 3. [lib/transfer/optimistic.js](../lib/transfer/optimistic.js) — version + retry

The opposite bet. Don't lock; check afterwards whether you were wrong:

```
read version (7) and balance  →  check balance
UPDATE accounts SET version = 8 WHERE id = $1 AND version = 7
  1 row  → nobody moved. Our read is still valid. Post.
  0 rows → someone committed first. Our balance is stale. Throw it away, retry.
```

The `UPDATE` is the whole trick: one atomic statement, so the check ("is the version still 7?")
and the claim ("now it is 8") cannot be split apart by another transaction. Note that
`assertSufficientFunds` throws *outside* the retryable set — a shortfall is a real answer, and
retrying will not conjure money.

Cost: wasted work. The `retries` column in the benchmark is that waste, measured. It shines when
contention is rare and hurts when it is not.

#### 4. [lib/transfer/serializable.js](../lib/transfer/serializable.js) — let the database do it

Look at the body: read the balance, check it, write the entries. That is `naive`, character for
character. **The only difference is the isolation level on the `BEGIN`.**

Postgres tracks read-write dependencies between concurrent transactions: ours reads a *range* of
`ledger_entries` (the SUM for one account) and another inserts into that range, so Postgres aborts
one with SQLSTATE `40001`. No lock, no version column — the conflict is detected, not prevented.

The catch, and it is not optional garnish: **any** transaction can be aborted at **any** time with
40001, including one that did nothing wrong. Without a retry loop, SERIALIZABLE surfaces in
production as random errors. Note also that the abort usually lands on the **COMMIT** — every
statement can succeed and the commit still fail — which is why the retry wraps the whole
transaction rather than any statement inside it.

**Adding a fifth strategy** means a new file exporting
`{ name, label, description, execute(transfer, { sourceKind }) }`, registered in `STRATEGIES` and
`STRATEGY_NAMES` in `index.js`. Nothing else changes — not the UI, not the benchmark.

---

### Stage 6 — The deliverable

**[scripts/bench.mjs](../scripts/bench.mjs)** (325 lines). Read the header, then follow the flow:

| Function | Line | Does |
|---|---|---|
| `readOption` / `CONFIG` | 29 | `--transfers`, `--amount`, `--balance`, `--strategies` |
| `createScenario` | 50 | Fresh funded account pair **per strategy** (the ledger can't be reset — Stage 1) |
| `warmUpPool` | 113 | Pre-open connections so the first transfer isn't measured with TCP setup in it |
| `runStrategy` | 123 | Fire N transfers at once, collect posted / failed / retries / duration |
| `buildHeadlineTable` | 189 | The table that lands in `docs/benchmark-results.md` |

```bash
npm run bench                                          # the deliverable
npm run bench -- --strategies=naive                    # one strategy
NAIVE_THINK_MS=25 npm run bench -- --strategies=naive  # widen the race window
```

**[scripts/idempotency-test.mjs](../scripts/idempotency-test.mjs)** (137 lines) — 100 concurrent
requests, one key. Asserts exactly one transfer row, exactly two ledger entries, one debit, and
99 callers getting the same transfer id back rather than an error.

There is no linter and no unit test framework. **These two scripts are the test suite**; both exit
non-zero on failure. Running one strategy is the equivalent of running one test.

---

### Stage 7 — The UI (last, and the least interesting part)

Next.js App Router, React Server Components querying `lib/db.js` **directly** — no API layer
between the page and the database.

| File | Note |
|---|---|
| [app/page.js](../app/page.js) | Accounts, balances, send form, recent transfers. `export const dynamic = 'force-dynamic'` because balances change on every transfer. |
| [app/actions.js](../app/actions.js) | The server action behind the form. No client JS, no fetch: the form posts, this runs, the browser redirects. Both posted *and* failed transfers land on the detail page — a failure is a story worth showing, not a dead end. |
| [app/transfers/[id]/page.js](../app/transfers/[id]/page.js) | The event timeline. This is where retries become visible. |
| [app/api/transfers/route.js](../app/api/transfers/route.js) | A parallel HTTP entry point, existing purely so idempotency can be demonstrated with curl. Also calls `executeTransfer`. |
| [app/components/MoneyInput.js](../app/components/MoneyInput.js) | Submits integer paise, so the server action has no decimal string to parse and no rounding decision to get wrong. |

`params` and `searchParams` are promises (Next 15). `next.config.mjs` sets
`serverExternalPackages: ['pg']` — `pg` must not be bundled.

**One convention that bites if you change half of it:** benchmark fixtures are hidden from the UI
by *two* filters in `app/page.js` — `u.email NOT LIKE 'bench+%'` for accounts and
`name NOT LIKE 'bench:%'` for transfers. The scripts name their throwaway accounts
`bench:<tag>:source` / `bench:<tag>:sink` under `bench+` users. Change one convention and you must
change the other, or hundreds of benchmark rows appear in the UI.

---

## The path of one transfer, end to end

```
  POST /api/transfers            form submit
  (route.js)                     (page.js → actions.js)
         └──────────┬──────────────────┘
                    ▼
        executeTransfer()                        lib/transfer/index.js
                    │
          1. validate amount, accounts, strategy
          2. SELECT accounts  →  need `kind`
          3. INSERT transfers ... ON CONFLICT (idempotency_key) DO NOTHING
                    │
             0 rows ├──────────────► replayExistingTransfer()  →  { replayed: true }
                    │
             1 row  ▼
          4. recordEvent('transfer.created', client = null)
                    │
                    ▼
        strategy.execute(transfer, { sourceKind })     one of four files
                    │
                    │   ┌── getBalanceMinor()        SUM over ledger_entries
                    │   ├── assertSufficientFunds()  system accounts exempt
                    │   ├── ─── the strategy's own mechanism ───
                    │   │       naive:        (nothing)
                    │   │       for-update:   SELECT ... FOR UPDATE
                    │   │       optimistic:   UPDATE ... WHERE version = $2
                    │   │       serializable: BEGIN ISOLATION LEVEL SERIALIZABLE
                    │   ├── postLedgerEntries()      two rows, summing to zero
                    │   └── markPosted()
                    │
         throws ────┼──── returns { retries }
                    │              │
                    ▼              ▼
     5a. markFailed(null, ...)   5b. recordEvent('transfer.posted')
         recordEvent('failed')
                    │              │
                    ▼              ▼
       { status: 'failed' }    { status: 'posted', retries }
```

Note where `client = null` appears: those events are written on a **separate connection**, so they
survive the rollback of the attempt they describe.

---

## Things that will look like bugs and are not

| Looks wrong | Actually |
|---|---|
| `naive.js` permits overdraft | The point of the project. Do not fix it, lock it, or wrap it in a transaction. |
| The mint account has a large negative balance | Correct double-entry. Every rupee came from somewhere. `kind = 'system'` is exempt from the funds check. |
| The benchmark creates new accounts every run | The ledger is append-only *by trigger*. It cannot be wiped. `npm run db:reset` is the only clear. |
| Conflict events are written outside the transaction | Deliberate. Inside, the rollback would erase them and the timeline would show no retries. |
| `for-update` locks `accounts`, not `ledger_entries` | The account row is a mutex for a balance that is a sum over many rows, some of which don't exist yet. |
| Insufficient funds returns rather than throws | The request was understood; the answer is "no". Only malformed requests throw. |
| No dashboards, charts, budgeting, search, or auth | All explicitly cut from v1. Scope is frozen. |

---

## Setup, in the order you'd actually run it

```bash
npm run db:migrate    # create the database, apply schema + seed
npm run bench         # the deliverable — overwrites docs/benchmark-results.md
npm run test:idempotency
npm run dev
```

Local Postgres 16 is on **port 5433** (a Postgres 14 also exists, on 5435). Scripts load
`.env.local` via Node's native `--env-file`, so run them through `npm run`, never
`node scripts/x.mjs` directly.

Do **not** run `npm run build` while `npm run dev` is running — they contend for `.next` and the
build fails with a misleading `Cannot find module for page` error.

If a benchmark change moves the numbers, `README.md` quotes them **by hand**: update its table
*and* the inline throughput and retry figures in the "Which one would I actually ship?" prose.
