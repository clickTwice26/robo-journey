# Running robo-journey

Postgres holds everything that must survive a restart: accounts, sessions, saved projects, and the
queue.

The wait between turns is not a fixed number. It is worked out from how many people are queuing at
the moment a seat is given up — the minimum when nobody is waiting, rising toward the maximum as
the queue lengthens — and an outstanding wait is shortened again if the queue clears, though never
lengthened. A cooldown exists to stop one person cycling through the same seat forever, and that
only matters when somebody else wants it. Redis holds the two things that are better off ephemeral — rate-limit counters and the
compile cache — and losing all of it costs nothing but a few recompiles.

## Putting it on a server

On a machine with nothing on it, one line takes it from bare to serving on your domain over HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/clickTwice26/robo-journey/master/deploy/bootstrap.sh | sudo bash -s -- --domain sim.example.com --email you@example.com
```

That runs as root, so read it before you trust it. It is short and it does only three things --
check for git and docker, clone the repository to `/opt/robo-journey`, and hand over to the
installer:

```bash
curl -fsSL https://raw.githubusercontent.com/clickTwice26/robo-journey/master/deploy/bootstrap.sh -o bootstrap.sh
less bootstrap.sh
sudo bash bootstrap.sh --domain sim.example.com --email you@example.com
```

If Docker is missing it offers to fetch [get.docker.com](https://get.docker.com) and asks first,
because that adds a package repository to your system and is not something to do on your behalf
quietly. `--yes` answers that too, which is what makes it usable from a provisioning tool.

Run it again later and it updates: it fast-forwards the checkout and re-runs the installer, which
keeps every secret already in `.env`. It stops rather than touching a checkout with uncommitted
changes in it -- someone editing a config on the server is a person, not a merge conflict.

| Flag | |
|---|---|
| `--dir <path>` | Where the checkout goes. Default `/opt/robo-journey`. |
| `--repo <url>` | Clone from somewhere else, such as your own fork, or an SSH URL for a private one. |
| `--branch <ref>` | Branch or tag. Default `master`. |
| `--dry-run` | Decide everything, change nothing. Over an existing install it reads *that* install and reports the update it would make. |

Everything it does not recognise is passed through to the installer, so the flags in the next
section work here too.

**It installs what is on GitHub, not what is on your laptop.** Push first, or point it at a branch
with `--branch`.

### From a checkout you already have

```bash
sudo ./deploy/install.sh --domain sim.example.com --email you@example.com
```

That is the whole thing. It writes a `.env` with a generated database password, builds the image,
starts the stack, and waits until the app reports ready.

**It looks at the machine before it changes anything**, which is the part that matters if the box
is already doing something else. Ports 80 and 443 free means Caddy takes them and handles the
certificate, including renewal. Anything already listening there -- nginx, Apache, another Caddy,
a load balancer -- and Caddy is *not started at all*. Instead the app binds to loopback and the
script writes a ready-to-paste site file for the proxy you already have, into `deploy/generated/`,
with the two commands to enable it in the header. Nothing that was already serving is interrupted.

`--dry-run` works all of it out and writes nothing, so you can read what it intends to do before
letting it. Running it twice is safe: secrets already in `.env` are kept and never regenerated,
while anything derived from the domain is rewritten, so changing the domain works.

| Flag | |
|---|---|
| `--domain <host>` | The name people will use. Without one it runs on loopback with no certificate. |
| `--email <address>` | Where Let's Encrypt sends expiry warnings. |
| `--app-port <port>` | Where the app listens on loopback. Default 28610; it picks another if that is taken. |
| `--behind-proxy` | Skip the check and always configure for an existing proxy. |
| `--dry-run` | Decide everything, change nothing. |
| `--yes` | Take every default, ask nothing. For scripts. |

It also checks that the domain actually resolves to this machine before letting Caddy try for a
certificate, because the alternative is finding out from a failed ACME challenge twenty minutes
later, and Let's Encrypt counts failures against a weekly limit.

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

The image takes minutes to build, so nothing that changes often should be inside it. Day to day,
Postgres and Redis run in containers -- they are infrastructure and never change -- and the service
and the studio run in terminals where a restart is a second.

```bash
npm run infra          # postgres + redis, in the background
npm run dev:service    # the service, in one terminal, restarting on change
npm run dev            # the studio, in another
```

Then open <http://localhost:28611>. Vite serves the studio and proxies `/api` to the service.

`npm run dev:service` reads `DATABASE_URL` and `REDIS_URL` from `.env`, pointing at the ports
Compose publishes on loopback (28632 and 28633). It builds first, then watches -- so a change to
any package is picked up by re-running `npm run build`, or by leaving `npm run watch` going in a
third terminal for continuous compilation.

The packaged service is behind a Compose profile so it does not compete for port 28610:

```bash
npm run stack          # docker compose --profile packaged up --build
```

That is the deployment artifact and the thing to test before a release; it is not the thing to
iterate in.

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
| `RJ_ACCESS_IDLE_MINUTES` | `2` | Untouched seat passes to the next person. |
| `RJ_TRUST_PROXY` | `false` | Turn on **only** behind something that sets `X-Forwarded-For`. Trusting it otherwise lets any client claim any address and every per-address limit becomes decorative. |
| `RJ_DB_SSL` | `false` | Verify the server certificate. |
| `RJ_SIGNUP_CREDITS` | `100` | Credits a confirmed account starts with. Granted on confirmation, not signup: accounts are free, so an allowance given to an unconfirmed address is one given to anybody who can type an address. |
| `GEMINI_API_KEY` | — | Optional. Without it datasheet extraction reports itself unavailable and everything else works. |
| `RJ_PUBLIC_URL` | `http://localhost:28610` | Where the app is reached from. Every link in outgoing mail is built from it, so it cannot be guessed from a request — a `Host` header is attacker-controlled. Warned about at start-up when a mail server is configured, but not enforced — set it before anyone else signs up. |
| `RJ_REQUIRE_VERIFIED_EMAIL` | `true` | Whether an address must be confirmed before an account can take a seat. |
| `SMTP_HOST` | — | Unset means links are printed to the log instead of sent, which is how local development works. Production refuses to start with verification on and no mail server, so `install.sh` asks for it and offers to turn verification off instead. |
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

## Credits

AI features are metered. A confirmed account starts with `RJ_SIGNUP_CREDITS`, and every movement
is recorded in a ledger the balance is checked against.

To hand existing confirmed accounts an allowance -- after a change to the starting figure, or for
accounts that confirmed before credits existed:

```bash
DATABASE_URL=postgres://... node packages/accounts/dist/backfill-credits.js 100
```

Safe to run repeatedly. Each grant carries the reference the signup grant uses, and a referenced
grant is honoured once, so this tops up whoever is missing it and does nothing for whoever is not.
