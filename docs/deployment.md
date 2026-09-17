# Deploying Flux

Flux ships as a Docker Compose stack: the Next.js app, a Postgres 16 database, and the two
scripts that are this project's test suite. The point is that a reader with Docker and nothing
else can reproduce the benchmark table in `benchmark-results.md` themselves.

```bash
docker compose up --build            # http://localhost:3000
docker compose run --rm bench        # 200 concurrent transfers per strategy
docker compose run --rm idempotency  # 100 concurrent requests, one key
docker compose run --rm reset        # drop the schema and re-seed
docker compose down                  # stop, keep the ledger
docker compose down -v               # stop, delete the ledger volume
```

Nothing needs to be installed first — no Node, no local Postgres, no `.env.local`.

## What starts, and in what order

| Service | Kind | What it does |
|---|---|---|
| `db` | long-running | Postgres 16, `max_connections=200`, data in the `pgdata` volume |
| `migrate` | runs once | creates the `flux` database, applies `db/001_schema.sql` + `db/002_seed.sql` |
| `web` | long-running | `next start` on port 3000 |
| `bench` / `idempotency` / `reset` | on demand | behind the `jobs` profile, so `up` never starts them |

`web` waits on `service_completed_successfully` for `migrate`, and `migrate` waits on the `db`
healthcheck, so `docker compose up --wait` returns only once the app can actually serve a page.
`web`'s own healthcheck fetches `/`, which reads balances out of Postgres — a green `web` means
the whole path is up, not just that a port is open.

## The ledger survives restarts

`migrate` runs on every `up`, and `db/001_schema.sql` is not idempotent — a second `CREATE TABLE
users` is an error. So the container runs it as `node scripts/migrate.mjs --if-needed`, which
checks for the `ledger_entries` table and exits 0 without touching anything if it is already
there.

That flag exists for containers only; it is deliberately not the default for `npm run db:migrate`,
where a migration that silently does nothing would hide a real mistake.

To clear the ledger, use `docker compose run --rm reset` (drops schema `public`, taking the
append-only triggers with it) or `docker compose down -v` (deletes the volume). There is no other
way — the append-only triggers, including the `BEFORE TRUNCATE` one, block everything else.

## Configuration

Every value has a working default. To override, copy `.env.docker.example` to `.env`, which
Compose reads automatically.

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | `postgres` | fine for a local demo; change it before exposing the database |
| `WEB_PORT` | `3000` | host port for the app |
| `DB_PORT` | `5439` | host port for Postgres. 5432–5435 are usually already taken on a machine that has run this project natively. The app does not use this port — it reaches `db:5432` over the Compose network |
| `DB_POOL_MAX` | `40` | the real ceiling on how many transfers are concurrent *inside* Postgres. **Changing it changes the benchmark results** |
| `NAIVE_THINK_MS` | `0` | simulated latency between read and write in the naive strategy |

Flags pass straight through to the scripts:

```bash
docker compose run --rm bench --strategies=naive --transfers=500
NAIVE_THINK_MS=25 docker compose run --rm bench --strategies=naive
```

`bench` bind-mounts `./docs`, so a containerised run overwrites `docs/benchmark-results.md` on
the host exactly as a local `npm run bench` does. The numbers will not match the committed table
— container CPU limits and an in-VM database change the throughput figures — so treat a
containerised run as a reproduction of the *shape* of the result, not of the exact numbers, and
do not commit its output unless you also update the figures quoted in `README.md`.

## Notes on the image

- Not a Next.js standalone build. Standalone traces only what the HTTP server needs, which would
  drop `db/*.sql` and `lib/` — and then the benchmark, the actual deliverable, could not run in
  the container. The image carries production `node_modules`, `.next`, `lib/`, `db/`, and
  `scripts/` instead.
- Runs as the unprivileged `node` user. `/app/docs` is chowned at build time because `bench.mjs`
  writes there.
- Inside the container the scripts are invoked as `node scripts/x.mjs`, not `npm run`. The npm
  scripts pass `--env-file=.env.local`, and in a container the environment is already set by
  Compose with no such file to read.
- `next start` is exec'd directly so it is PID 1 and gets SIGTERM from `docker compose down`.

## Deploying somewhere other than Docker

The image is a plain long-running Node server, so anything that runs a container works: Fly.io,
Railway, Render, ECS. Point `DATABASE_URL` at a managed Postgres and run
`node scripts/migrate.mjs` once against it.

Serverless platforms are a poor fit and worth understanding rather than working around. Every
strategy here holds a transaction open across multiple statements on one connection, and
`DB_POOL_MAX` is the variable the whole benchmark turns on. A per-invocation runtime behind a
transaction-pooling proxy gives you neither a stable pool size nor a guaranteed sticky session —
so the numbers stop meaning anything, and `SELECT ... FOR UPDATE` stops behaving the way the
`for-update` strategy assumes.

That is an argument about the *benchmark*, not about the app. A hosted link where someone can
send a transfer and watch the event timeline is still worth having, and it is free.

## The free path: a public link in ~10 minutes

**Neon** for Postgres, **Vercel** for the app. No card, no expiry. The benchmark stays on your
laptop, where its numbers mean something.

### 1. Database

1. Sign up at <https://neon.tech> with GitHub and create a project.
2. Copy the **pooled** connection string — its host contains `-pooler`:

   ```
   postgresql://neondb_owner:PASSWORD@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
   ```

   Pooled matters: each Vercel instance opens its own `pg` pool, and the direct endpoint runs
   out of connections fast. `sslmode=require` is handled by `pg` itself — `lib/db.js` needs no
   change.

3. Locally, create `.env.prod.local` (gitignored, same shape as `.env.local`):

   ```
   DATABASE_URL=postgresql://...-pooler...neon.tech/neondb?sslmode=require
   DB_POOL_MAX=5
   ```

4. Apply the schema and seed:

   ```bash
   npm run db:migrate:prod     # npm run db:reset:prod wipes it later
   ```

   It prints the seeded accounts and `invariant ok: true`. Neon does expose a `postgres`
   maintenance database, so the script's `CREATE DATABASE` precheck runs normally and reports
   `database "neondb" already exists`. On a provider that does not expose one, the precheck now
   logs why it skipped and carries on instead of aborting the migration.

### 2. App

Import the repo at <https://vercel.com> (Add New → Project). Keep every build setting — the
Next.js preset is correct. Add two environment variables before the first deploy:

| Name | Value |
|---|---|
| `DATABASE_URL` | the same pooled Neon string |
| `DB_POOL_MAX` | `5` |

Deploy. Pushes to `main` redeploy on their own.

`DB_POOL_MAX` is the only value that should differ from local, and the reason is the one above:
40 is the point of the benchmark, but on Vercel the pool is per-instance, so a big number buys
no extra concurrency and just holds Neon connections open.

The file is deliberately **not** called `.env.production.local`. Next.js loads that exact name
itself, ahead of `.env.local`, which silently points `npm run build` and `npm run start` on your
laptop at the deployed database. `.env.prod.local` means nothing to Next.js, so only the two
`:prod` scripts read it.

### What to expect

- Neon's free compute sleeps after ~5 minutes idle; the first request after that takes a second
  or two to wake it. Nothing is lost.
- The hosted ledger is public and append-only — anyone with the link can transfer, and nothing
  can delete the rows. Reseed with `npm run db:reset:prod`.
- Do not point `npm run bench` at Neon. It would measure your Wi-Fi rather than the strategies,
  and leave a few hundred `bench:` rows in the hosted ledger.
