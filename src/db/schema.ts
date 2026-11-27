/**
 * D1 schema, created on first use. The Deploy button provisions an empty database and there is no
 * reliable place to run `wrangler d1 migrations apply` before the first request, so the Worker
 * creates its own tables (idempotent) the first time a query hits "no such table".
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS events (
     event_key   TEXT PRIMARY KEY,
     service     TEXT NOT NULL,
     received_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
     seq               INTEGER PRIMARY KEY AUTOINCREMENT,
     delivery_id       TEXT NOT NULL UNIQUE,
     subscription_name TEXT NOT NULL,
     event             TEXT NOT NULL,
     source_event_key  TEXT NOT NULL,
     status            TEXT NOT NULL,
     attempts          INTEGER NOT NULL DEFAULT 0,
     max_attempts      INTEGER NOT NULL,
     available_at      INTEGER NOT NULL,
     lease_until       INTEGER,
     claimed_by        TEXT,
     consumer          TEXT,
     body              TEXT NOT NULL,
     result            TEXT,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries (status, available_at, seq)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     INTEGER NOT NULL,
     kind   TEXT NOT NULL,
     ref    TEXT,
     detail TEXT
   )`,
];

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  await addColumnIfMissing(db, 'deliveries', 'consumer', 'TEXT');
}

/** Databases provisioned before a column existed: CREATE TABLE IF NOT EXISTS leaves them as they were, so add it. */
async function addColumnIfMissing(db: D1Database, table: string, column: string, type: string): Promise<void> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (results.some((c) => c.name === column)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch (err) {
    if (!/duplicate column name/i.test(String((err as Error)?.message ?? err))) throw err; // another request added it first
  }
}

/** Runs `fn`; if the tables or a newer column do not exist yet, creates/adds them and runs it once more. */
export async function withSchema<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!/no such (table|column)|has no column named/i.test(String((err as Error)?.message ?? err))) throw err;
    await ensureSchema(db);
    return fn();
  }
}

export async function audit(db: D1Database, kind: string, ref: string | null, detail: unknown): Promise<void> {
  await withSchema(db, () =>
    db.prepare('INSERT INTO audit (at, kind, ref, detail) VALUES (?, ?, ?, ?)').bind(Date.now(), kind, ref, detail === undefined ? null : JSON.stringify(detail)).run(),
  );
}
