/**
 * One-shot import from the old SQLite database.
 *
 * Written for a single migration and kept because throwing it away would mean anyone with an
 * existing `robo-journey.db` silently loses their account. It reads the old file, writes into
 * Postgres, and refuses to touch a row that already exists -- so running it twice is safe and
 * running it against a populated database does not overwrite anything.
 *
 *   node packages/accounts/dist/import-sqlite.js ./packages/compile-service/robo-journey.db
 *
 * Sessions are deliberately not carried over. They are cheap to recreate by signing in, and a
 * token hash copied between databases is a credential moved around for no benefit.
 */
import { DatabaseSync } from 'node:sqlite';
import { createPool } from './db.js';
import { migrate } from './migrations.js';

interface OldUser {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
}

interface OldProject {
  id: string;
  user_id: string;
  name: string;
  document: string;
  created_at: string;
  updated_at: string;
}

export async function importSqlite(file: string, databaseUrl: string): Promise<{
  users: number;
  projects: number;
  skipped: number;
}> {
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const pool = createPool({ url: databaseUrl, poolSize: 2, applicationName: 'robo-journey-import' });

  try {
    await migrate(pool);

    const users = sqlite.prepare('SELECT * FROM users').all() as unknown as OldUser[];
    const projects = sqlite.prepare('SELECT * FROM projects').all() as unknown as OldProject[];

    let importedUsers = 0;
    let skipped = 0;

    for (const user of users) {
      // The hash format is unchanged, so passwords keep working; only the store around it moved.
      const result = await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, created_at)
         VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [user.id, user.email, user.display_name, user.password_hash, user.created_at],
      );
      if (result.rowCount) importedUsers++;
      else skipped++;
    }

    let importedProjects = 0;
    for (const project of projects) {
      // Documents were stored as text and are JSONB now. A row that will not parse is skipped
      // rather than imported as a string, which would be a document nothing can read.
      let document: unknown;
      try {
        document = JSON.parse(project.document);
      } catch {
        skipped++;
        continue;
      }

      const result = await pool.query(
        `INSERT INTO projects (id, user_id, name, document, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          project.id,
          project.user_id,
          project.name,
          JSON.stringify(document),
          project.created_at,
          project.updated_at,
        ],
      );
      if (result.rowCount) importedProjects++;
      else skipped++;
    }

    return { users: importedUsers, projects: importedProjects, skipped };
  } finally {
    sqlite.close();
    await pool.end();
  }
}

// Run directly, not when imported.
if (process.argv[1]?.endsWith('import-sqlite.js')) {
  const file = process.argv[2];
  const url = process.env.DATABASE_URL;

  if (!file || !url) {
    console.error(
      'Usage: DATABASE_URL=postgres://... node import-sqlite.js <path-to-robo-journey.db>',
    );
    process.exit(64); // EX_USAGE
  }

  importSqlite(file, url)
    .then(({ users, projects, skipped }) => {
      console.log(`Imported ${users} user(s) and ${projects} project(s). Skipped ${skipped}.`);
    })
    .catch((error: unknown) => {
      console.error('Import failed:', error);
      process.exit(1);
    });
}
