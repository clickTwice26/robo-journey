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
