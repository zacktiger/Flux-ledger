# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Flux is a **money-movement correctness demo**, not a wallet product. It exists to produce one
artifact: a benchmark table showing that four concurrency-control strategies behave differently
under 200 parallel transfers against a single account. It is a student resume project, so the code
is deliberately heavily commented and optimised for a reader, not for feature count.

Two consequences that override normal instincts:

- **`lib/transfer/naive.js` is broken on purpose.** It permits overdraft under concurrency. Do not
  "fix" it, add a lock to it, or wrap it in a transaction. Its failure is the headline result of the
  whole project.
- **Scope is frozen.** Dashboards, charts, budgeting, search, notifications, and auth were all
  explicitly cut from v1. Do not add them unprompted.

## Commands

```bash
npm run db:migrate        # create the flux database, apply schema + seed
npm run db:reset          # drop schema public, recreate, re-seed  <- the only way to clear the ledger
npm run bench             # THE deliverable: 200 concurrent transfers per strategy
npm run test:idempotency  # 100 concurrent requests, one idempotency key
npm run dev               # Next.js dev server
npm run build             # production build
```

Benchmark flags (there is no test runner; running one strategy is the equivalent of running one test):

```bash
npm run bench -- --strategies=naive           # one strategy only
npm run bench -- --transfers=500 --amount=10 --balance=1000
NAIVE_THINK_MS=25 npm run bench -- --strategies=naive   # widen the race window on purpose
```

`npm run bench` overwrites `docs/benchmark-results.md`. That file is generated — edit
`scripts/bench.mjs`, not the output. `README.md` quotes those numbers by hand, so if a benchmark
change moves them, update the README table **and** the prose figures in the "Which one would I
actually ship?" section, which cite throughput and retry counts inline.

Do not run `npm run build` while `npm run dev` is running — they contend for `.next` and the build
fails with a misleading `Cannot find module for page` error.

There is no linter, no formatter, and no unit test framework. `bench.mjs` and `idempotency-test.mjs`
are the test suite; both exit non-zero on failure.

## Environment

Scripts load `.env.local` via Node's native `--env-file`, so they are run through `npm run`, not
`node scripts/x.mjs` directly. Next.js loads the same file on its own.

Local Postgres 16 listens on **port 5433** (Postgres 14 is also installed, on 5435). `DB_POOL_MAX`
is the real ceiling on how many transfers are concurrent *inside Postgres* during the benchmark —
changing it changes the results.

## Architecture

### The core rule: no stored balances

There is no `balance` column anywhere, and adding one would defeat the project. A balance is
`SUM(amount_minor)` over `ledger_entries`, exposed as the `account_balances` view. `ledger_invariant`
is a view you can query at any moment to assert correctness.

Money is **integer paise in BIGINT** everywhere. `lib/db.js` registers a `pg` type parser for oid 20
so BIGINT arrives as a JS number rather than a string; without it every amount comparison silently
becomes string comparison.

### The ledger is append-only, enforced by the database

`db/001_schema.sql` installs three triggers on `ledger_entries`: `BEFORE UPDATE`, `BEFORE DELETE`,
and — importantly — `BEFORE TRUNCATE FOR EACH STATEMENT`. Row-level triggers do not fire on
TRUNCATE, so without the third one the append-only guarantee is a lie.

This has a design consequence that will otherwise look strange: **the benchmark cannot reset the
ledger between runs**, so it creates a fresh funded account pair for each strategy instead. Only
`npm run db:reset` (which drops the whole schema) clears data.

### Two distinct invariants

Keep these separate when reasoning or writing docs:

| Invariant | Broken by naive? | Enforced by |
|---|---|---|
| `SUM(amount_minor) = 0` — no money created or destroyed | **No** | double-entry itself |
| No user account below zero | **Yes** | concurrency control |

Double-entry holds even under the broken strategy, because every transfer still writes a matching
debit and credit. What naive breaks is the business rule. `ledger_invariant` reports both.

System accounts (`kind = 'system'`, the "Flux Mint") are *expected* to be negative — they are the
origin of all money. `assertSufficientFunds()` exempts them, and `ledger_invariant` only counts
overdrawn `kind = 'user'` accounts.

### Transfer execution: one shared path, four swappable strategies

`lib/transfer/index.js` (`executeTransfer`) owns everything that does not depend on the strategy:
validation, account lookup, idempotency-key claiming, transfer row creation, and recording the final
outcome. A strategy module receives an already-created transfer row and is responsible for exactly
one thing: moving the money without letting a concurrent transfer corrupt the balance.

Shared mechanics (`getBalanceMinor`, `postLedgerEntries`, `markPosted`, `recordEvent`,
`retryOnConflict`) live in `lib/transfer/shared.js` so the four strategy files stay short enough to
read side by side. **Adding a strategy** means a new file exporting `{ name, label, description,
execute(transfer, { sourceKind }) }`, registered in `STRATEGIES` and `STRATEGY_NAMES` in
`index.js` — nothing else changes, including the UI and the benchmark.

Error contract, and it is easy to get backwards:

- A strategy **throws** on business failure (`TransferError`) or conflict exhaustion. Its transaction
  rolls back, then `executeTransfer` marks the transfer `failed` on a fresh connection.
- `executeTransfer` **returns** `{ status: 'failed' }` for that case. It only **throws** for malformed
  requests — unknown account, bad amount, unknown strategy. Callers (API route, server action) rely
  on this split.

The two conflict-detecting strategies (`optimistic`, `serializable`) own their retry loop via
`retryOnConflict`; the retry loop is part of the strategy, not error handling bolted on. `naive` and
`for-update` never retry and always report `retries: 0`.

### Events survive rollback on purpose

`recordEvent(client, ...)` writes inside the caller's transaction. `recordEvent(null, ...)` writes on
a separate pooled connection. Conflict events **must** use `null` — they describe an attempt that was
just rolled back, so writing them inside that transaction would erase them. This is why the timeline
can show retries at all.

### UI

Next.js App Router, React Server Components querying `lib/db.js` directly — no API layer between the
page and the database. Pages set `export const dynamic = 'force-dynamic'` because balances change on
every transfer. `params` and `searchParams` are promises (Next 15).

The send form posts to a **server action** (`app/actions.js`); `app/api/transfers/route.js` is a
parallel HTTP entry point that exists so idempotency can be demonstrated with curl. Both call
`executeTransfer`.

`next.config.mjs` sets `serverExternalPackages: ['pg']` — `pg` must not be bundled.

### Benchmark and test fixtures are hidden from the UI by naming convention

Throwaway accounts created by `bench.mjs` and `idempotency-test.mjs` are named `bench:<tag>:source` /
`bench:<tag>:sink` and owned by users whose email starts with `bench+`. `app/page.js` filters on
**both** (`u.email NOT LIKE 'bench+%'` for accounts, `name NOT LIKE 'bench:%'` for transfers). Change
one convention and you must change the other, or hundreds of benchmark rows appear in the UI.

## Other agent configs present

`~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. To pull their MCP
servers, commands, subagents, or skills into Claude Code, reply `/import` to scan and list what is
importable, then `/import --yes=<digest>` to apply it. (If `/import` is unavailable on this surface,
run `claude import` from a terminal.)
