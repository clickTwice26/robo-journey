# packages/accounts

Postgres, and every query that touches it. This package depends on nothing else of ours: it is a
leaf, and the service is the only thing that calls it.

```
packages/accounts/src/
├── db.ts              the pool, and running migrations under an advisory lock
├── migrations.ts      versioned, forward-only, each one numbered
├── store.ts           users and sessions
├── passwords.ts       hashing
├── email-tokens.ts    verification and password reset, single-use
├── access.ts          the seat queue
├── credits.ts         balances, holds, and the ledger
├── invites.ts         codes, redemptions, and the reward
├── backfill-credits.ts / import-sqlite.ts   one-off migrations from the old shape
```

## The schema

### Who you are

```mermaid
erDiagram
  users ||--o{ sessions : "signs in"
  users ||--o{ email_tokens : "verify, reset"
  users ||--o{ projects : "saves"

  users {
    uuid id PK
    text email UK
    text display_name
    text password_hash
    timestamptz created_at
  }
  sessions {
    text token_hash PK
    uuid user_id FK
    timestamptz expires_at
  }
  email_tokens {
    text token_hash PK
    uuid user_id FK
    timestamptz expires_at
  }
  projects {
    uuid id PK
    uuid user_id FK
    text name
    jsonb document
    timestamptz updated_at
  }
```

### What you may do

```mermaid
erDiagram
  users ||--|| access : "queues for a seat"
  users ||--|| credit_accounts : "has a balance"
  users ||--o{ credit_ledger : "every change, recorded"
  users ||--|| invite_codes : "owns one code"
  users ||--o{ invite_redemptions : "invited"

  users {
    uuid id PK
    text email UK
  }
  access {
    uuid user_id PK
    access_state state
    bigint queue_seq
    timestamptz expires_at
    timestamptz last_seen_at
    bigint carry_ms
  }
  credit_accounts {
    uuid user_id PK
    bigint balance
    bigint held
  }
  credit_ledger {
    bigserial id PK
    uuid user_id FK
    credit_entry_kind kind
    bigint delta
    bigint balance_after
    text reason
    text feature
  }
  invite_codes {
    uuid user_id PK
    text code UK
  }
  invite_redemptions {
    uuid invitee_id PK
    uuid inviter_id FK
    timestamptz rewarded_at
  }
```

Sessions store a **hash** of the token, not the token. A dump of this table does not let anyone in.

`projects.document` is the `.rjp` JSON, stored whole. The schema does not know what a wire is and
does not need to; validation belongs to `parseProject`, in one place, on the way in.

## Concurrency

Money and seats are the two places where two requests arriving at the same moment can produce an
answer that is wrong rather than merely late, so both are settled by the database.

- **Credits are a balance plus a ledger.** Every change writes a row with the balance it produced,
  so a disagreement can be read back rather than guessed at.
- **A charge is a hold, then a settle.** The assistant reserves before it calls the model and
  settles after, so a request that fails does not bill.
- **The invite reward is a conditional `UPDATE`.** `WHERE rewarded_at IS NULL` is what makes two
  racing confirmations pay once. `invite_redemptions` has `CHECK (invitee_id <> inviter_id)` so a
  code cannot reward its own owner.
- **Migrations run under an advisory lock.** Three service replicas starting together run them once
  between them.

These were tested against real Postgres with genuinely concurrent requests, not mocks — see
[../testing.md](../testing.md).

## Migrations

Numbered, forward-only, and applied in order. `schema_migrations` records what has run. Adding one
means appending to `migrations.ts`; never edit a migration that has shipped, because someone's
database has already run it.
