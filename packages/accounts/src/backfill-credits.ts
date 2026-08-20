/**
 * Give every confirmed account its starting credits.
 *
 * For accounts that confirmed their address before credits existed, and for a change to the
 * starting figure that should reach people who signed up under the old one.
 *
 * Safe to run repeatedly. Each grant carries the same reference the signup grant uses, and a
 * referenced grant is honoured once -- so this tops up whoever is missing it and does nothing at
 * all for whoever is not.
 *
 *   DATABASE_URL=postgres://... node packages/accounts/dist/backfill-credits.js 100
 */
import { createPool } from './db.js';
import { CreditStore } from './credits.js';

export async function backfillSignupCredits(
  databaseUrl: string,
  amount: number,
): Promise<{ granted: number; alreadyHad: number }> {
  const pool = createPool({ url: databaseUrl, poolSize: 2, applicationName: 'robo-journey-backfill' });
  const credits = new CreditStore(pool);

  try {
    // Confirmed accounts only, for the same reason the signup grant waits for confirmation:
    // accounts are free, and an allowance given to an unconfirmed address is an allowance given to
    // anybody who can type one.
    const { rows } = await pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email_verified_at IS NOT NULL ORDER BY created_at',
    );

    let granted = 0;
    let alreadyHad = 0;

    for (const user of rows) {
      const before = await credits.balance(user.id);
      await credits.grant(user.id, amount, {
        reason: 'Welcome to robo-journey',
        feature: 'signup',
        reference: 'signup',
      });
      const after = await credits.balance(user.id);
      if (after.available > before.available) granted++;
      else alreadyHad++;
    }

    return { granted, alreadyHad };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('backfill-credits.js')) {
  const amount = Number(process.argv[2] ?? 100);
  const url = process.env.DATABASE_URL;

  if (!url || !Number.isInteger(amount) || amount <= 0) {
    console.error('Usage: DATABASE_URL=postgres://... node backfill-credits.js <amount>');
    process.exit(64);
  }

  backfillSignupCredits(url, amount)
    .then(({ granted, alreadyHad }) => {
      console.log(`Granted ${amount} credits to ${granted} account(s). ${alreadyHad} already had them.`);
    })
    .catch((error: unknown) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
