# Running robo-journey

Postgres holds everything that must survive a restart: accounts, sessions, saved projects, and the
queue.

The wait between turns is not a fixed number. It is worked out from how many people are queuing at
the moment a seat is given up — the minimum when nobody is waiting, rising toward the maximum as
the queue lengthens — and an outstanding wait is shortened again if the queue clears, though never
lengthened. A cooldown exists to stop one person cycling through the same seat forever, and that
only matters when somebody else wants it. Redis holds the two things that are better off ephemeral — rate-limit counters and the
compile cache — and losing all of it costs nothing but a few recompiles.

## The stack

```bash
cp .env.example .env
# set POSTGRES_PASSWORD; `openssl rand -base64 32` is a reasonable source
docker compose up --build
```

Then open <http://127.0.0.1:28610>. The service serves the built studio and the API from the same
origin, so there is no proxy and no CORS to configure.

| Endpoint | For |
|---|---|
| `/health` | Liveness. No dependencies, so a restart policy can be wired to it safely. |
| `/ready` | Readiness. Checks Postgres and Redis; 503 when either is down. |
| `/info` | Effective configuration, minus anything secret. |

Wire a **restart** policy to `/health` and a **load balancer** to `/ready`. The other way round
turns one bad minute from Postgres into a crash loop across every instance.

## Developing

The full image takes a few minutes to build, so day to day run only the backing services and keep
the fast feedback of Vite:

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres + redis
npm run service                                  # in one terminal
npm run dev                                      # in another
```

`npm run service` needs `DATABASE_URL` and `REDIS_URL`; the commented lines at the bottom of
`.env.example` match what the dev compose file publishes.

## Coming from the SQLite build

Earlier versions kept everything in `robo-journey.db`. Accounts and projects import in one step,
and it is safe to run twice — existing rows are left alone:

```bash
DATABASE_URL=postgres://... npm run import:sqlite -- ./packages/compile-service/robo-journey.db
```

Sessions are deliberately not carried over. They cost one sign-in to recreate, and copying token
hashes between databases moves a credential around for no benefit.

## Configuration

Every variable is validated at start-up. A missing or malformed one fails the boot with a message
naming it and exits `78` (`EX_CONFIG`), rather than surfacing hours later as a connection error on
whichever request happened to need it first.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | Required. No default on purpose: one would let a misconfigured deploy come up against an empty local database and appear to work. |
| `REDIS_URL` | — | Required. |
| `RJ_ACCESS_CAPACITY` | `10` | People using the simulator at once. |
| `RJ_ACCESS_SESSION_MINUTES` | `60` | Length of a turn. |
| `RJ_ACCESS_COOLDOWN_MIN_MINUTES` | `1` | Wait between turns when nobody is queuing. |
| `RJ_ACCESS_COOLDOWN_MAX_MINUTES` | `20` | Ceiling on that wait, reached when the queue is as long as the room is wide. |
| `RJ_ACCESS_IDLE_MINUTES` | `2` | Untouched seat passes to the next person. |
| `RJ_TRUST_PROXY` | `false` | Turn on **only** behind something that sets `X-Forwarded-For`. Trusting it otherwise lets any client claim any address and every per-address limit becomes decorative. |
| `RJ_DB_SSL` | `false` | Verify the server certificate. |
| `GEMINI_API_KEY` | — | Optional. Without it datasheet extraction reports itself unavailable and everything else works. |
| `RJ_PUBLIC_URL` | `http://localhost:28610` | Where the app is reached from. Every link in outgoing mail is built from it, so it cannot be guessed from a request — a `Host` header is attacker-controlled. Production refuses to start if this is still localhost. |
| `RJ_REQUIRE_VERIFIED_EMAIL` | `true` | Whether an address must be confirmed before an account can take a seat. |
| `SMTP_HOST` | — | Unset means links are printed to the log instead of sent, which is how local development works. Production refuses to start with verification on and no mail server. |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | inferred | `true` on port 465, `false` elsewhere. Set it only to override. On STARTTLS ports the code requires the upgrade, so credentials are never sent in the clear either way. |
| `SMTP_USER` / `SMTP_PASSWORD` | — | |
| `SMTP_FROM` | `robo-journey <no-reply@localhost>` | |

## Email

Confirming an address is what makes the queue mean anything. Accounts are free, so a per-account
cooldown is only a limit if an account costs something to make — and a mailbox is that cost.
Without it, anyone wanting a permanent seat registers ten accounts.

Credentials go in `.env` at the repository root. It is gitignored, and nothing from it is baked
into an image; Compose passes the values to the service at run time.

```bash
RJ_PUBLIC_URL=https://yourdomain.com
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=robo-journey <no-reply@yourdomain.com>
```

**Without a mail server it still works.** Links are printed to the service log instead of sent, so
the whole flow is clickable on a laptop:

```bash
docker compose logs -f service | grep '\[mail\]'
```

That is a development mode, not a fallback: in production the service refuses to start with
verification switched on and no mail server, because a deployment that demands confirmation and
cannot send it is one nobody can ever get into.

Password reset uses the same machinery. Reset links last an hour against a verification link's
day, can be spent once, supersede any earlier one, and signing a new password in destroys every
session on every device — a reset means the account holder has lost control, and leaving whoever
else was signed in still signed in would defeat the point.

## Scaling out

The queue is correct across instances, which is most of the reason for Postgres. Every reconcile
pass runs in a transaction holding `pg_advisory_xact_lock`, so two instances cannot both hand out
the tenth seat — and the lock is transaction-scoped, so it releases even if a process dies holding
it.

Sessions are database-backed rather than in-memory, so requests do not need to be pinned to an
instance.

## What the container can and cannot do

- Runs as uid 10001, not root.
- Read-only root filesystem, with a tmpfs at `/tmp` for sketch builds.
- All capabilities dropped, `no-new-privileges`.
- `arduino-cli` is baked into the image. The alternative — mounting the host's Docker socket so the
  service can start a toolchain container — hands the container root on the host, which is a poor
  trade for the ability to compile a sketch.

One thing that changed with it: the Docker-based compiler ran the toolchain with `--network none`,
so a sketch could not fetch anything at build time. Running `arduino-cli` in-process gives that up.
Nothing in a compile downloads today — the AVR core is baked in — but if untrusted sketches are
ever accepted, put the service on a network that cannot reach anything but Postgres and Redis.

## Backups

Only Postgres holds anything worth keeping:

```bash
docker compose exec postgres pg_dump -U robo robo_journey | gzip > backup.sql.gz
```
