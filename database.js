
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing. Configure it in Render.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (error) => {
  console.error('PostgreSQL idle connection error:', error);
});

export async function query(sql, params = []) {
  return pool.query(sql, params);
}

export async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ?? null;
}

export async function many(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function transaction(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mobile TEXT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      blocked INTEGER DEFAULT 0,
      must_change INTEGER DEFAULT 0,
      balance BIGINT DEFAULT 0 CHECK (balance >= 0),
      loss_progress BIGINT DEFAULT 0,
      welcome_used INTEGER DEFAULT 0,
      promo_used INTEGER DEFAULT 0,
      created BIGINT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      expires BIGINT
    );

    CREATE TABLE IF NOT EXISTS signups (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE,
      name TEXT,
      mobile TEXT,
      username TEXT,
      status TEXT DEFAULT 'pending',
      delivery TEXT,
      created BIGINT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pending_username
      ON signups(username) WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS pending_mobile
      ON signups(mobile) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      amount BIGINT,
      kind TEXT,
      note TEXT,
      ref TEXT UNIQUE,
      created BIGINT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      kind TEXT,
      amount BIGINT,
      status TEXT DEFAULT 'pending',
      details TEXT,
      proof BYTEA,
      mime TEXT,
      created BIGINT,
      decided BIGINT
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      table_id TEXT,
      status TEXT,
      state TEXT,
      created BIGINT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      actor TEXT,
      action TEXT,
      details TEXT,
      created BIGINT
    );

    CREATE TABLE IF NOT EXISTS disabled_tables (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS tour_templates (
      id TEXT PRIMARY KEY,
      config TEXT
    );

    CREATE TABLE IF NOT EXISTS tour_fund (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      balance BIGINT NOT NULL CHECK (balance >= 0)
    );

    CREATE TABLE IF NOT EXISTS tour_fund_ledger (
      id TEXT PRIMARY KEY,
      amount BIGINT,
      kind TEXT,
      note TEXT,
      ref TEXT UNIQUE,
      created BIGINT
    );

    CREATE TABLE IF NOT EXISTS tour_events (
      id TEXT PRIMARY KEY,
      template_id TEXT,
      start BIGINT,
      closes BIGINT,
      opens BIGINT,
      status TEXT,
      config TEXT,
      round INTEGER DEFAULT 0,
      reserve BIGINT DEFAULT 0,
      created BIGINT,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS tour_entries (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES tour_events(id),
      user_id TEXT,
      name TEXT,
      bot INTEGER,
      status TEXT,
      score INTEGER DEFAULT 0,
      played INTEGER DEFAULT 0,
      rank INTEGER,
      prize BIGINT DEFAULT 0,
      created BIGINT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tour_one_entry
      ON tour_entries(event_id, user_id)
      WHERE status != 'cancelled';

    CREATE TABLE IF NOT EXISTS tour_matches (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES tour_events(id),
      round INTEGER,
      number INTEGER,
      status TEXT,
      UNIQUE(event_id, round, number)
    );

    INSERT INTO tour_fund(id, balance)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log('PostgreSQL database tables initialized.');
}

export async function closeDatabase() {
  await pool.end();
}
