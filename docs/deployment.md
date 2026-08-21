# Deployment

The operator's guide is [../DEPLOYMENT.md](../DEPLOYMENT.md) — flags, what to do about an existing
nginx, what goes in `.env`. This page is the shape of the thing, for people changing it.

```
deploy/
├── bootstrap.sh   curl-able: check git and docker, clone, hand over
├── install.sh     look at the machine, write .env, start the stack
└── Caddyfile      the edge, when this machine's 80 and 443 are free
```

## From nothing to serving

```mermaid
flowchart TD
  curl["curl … | sudo bash"] --> boot["bootstrap.sh"]
  boot --> tools{"git and docker?"}
  tools -->|missing| offer["offer to install<br/>— asks first"]
  tools -->|present| clone
  offer --> clone["clone to /opt/robo-journey"]
  clone --> inst["install.sh"]

  inst --> look{"is 80 or 443 taken?"}
  look -->|free| edge["EDGE<br/>Caddy takes them,<br/>gets a certificate, renews forever"]
  look -->|taken| behind["BEHIND<br/>Caddy is not started.<br/>App on loopback, and a site file<br/>written for the proxy you already have"]

  edge --> up["docker compose --profile packaged --profile edge up"]
  behind --> up2["docker compose --profile packaged up"]

  classDef good fill:#2d4a2b,stroke:#5a8f56,color:#eaf5e9
  class edge,behind good
```

**The whole design is one idea: find out what is already running before changing anything.** A
deploy script that assumes it owns port 443 takes down whatever was serving on it, and the person
who ran it finds out from their users.

## The containers

```mermaid
graph LR
  net["the internet"] -->|443| caddy["caddy<br/>profile: edge"]
  caddy -->|"compose network"| svc["service<br/>profile: packaged"]
  svc --> pg[("postgres<br/>127.0.0.1:28632")]
  svc --> rd[("redis<br/>127.0.0.1:28633")]
  svc -.->|"published on loopback only"| lo["127.0.0.1:28610"]

  classDef edge fill:#3a2f1f,stroke:#a8874a,color:#f5ecdc
  class caddy edge
```

Two compose profiles. `packaged` is the app and its stores; `edge` adds Caddy and is enabled only
when the installer found 80 and 443 free. Everything except Caddy publishes on **loopback only** —
the app is not reachable from outside except through whatever is out front.

## Certificates

Caddy 2 does Let's Encrypt automatically. Two things make it survive contact with reality:

- **`RJ_ACME_EMAIL`** goes on the ACME account, so expiry warnings reach a person. Blank is allowed
  and means no warnings — a choice the installer asks about rather than an accident.
- **`caddy-data` is a named volume.** Certificates and the account key live there, so a rebuild is
  not a re-issue. Let's Encrypt counts issuances per week, not per deploy, and a redeploy loop
  against a lost volume is how people get rate-limited.

The installer checks the domain resolves to this machine **before** letting Caddy try, because the
alternative is finding out from a failed ACME challenge twenty minutes later — and failures count
against the same weekly limit.

HSTS is set for a year, but only in the edge Caddyfile, where TLS is actually working. Setting it
before a certificate exists locks people out of a site that cannot yet serve them.

## Running it twice

Both scripts are idempotent, and the distinction is deliberate:

- **Secrets already in `.env` are kept, never regenerated.** Regenerating the database password on
  a second run would leave the app unable to open the database it created on the first.
- **Values derived from the domain are rewritten**, so changing the domain actually changes it.
- `bootstrap.sh` fast-forwards the checkout and re-runs the installer — but **stops** rather than
  touching a checkout with uncommitted changes in it.

`--dry-run` decides everything and writes nothing, so it can be read before it is trusted.

## Before exposing this to strangers

Recorded here because it is real and not fixed: **the compile sandbox does not contain a
sketch's `#include`.** A `#include "/etc/hostname"` reads a container file and leaks it through the
compiler diagnostics. Everything else on the list — security headers, authenticating `/info`, a
per-user quota on datasheet extraction, scheduled backups, CI — is ordinary hardening. This one is
the one to close first.
