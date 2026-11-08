
import { pool, initializeDatabase } from './database.js';

async function main() {
  try {
    console.log('Checking PostgreSQL connection...');

    const result = await pool.query(`
      SELECT
        current_database() AS database_name,
        NOW() AS server_time
    `);

    console.log('Connected to:', result.rows[0].database_name);

    await initializeDatabase();

    const tables = await pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `);

    console.log('Database tables:', tables.rows[0].count);
    console.log('POSTGRESQL CONNECTION SUCCESS');
  } catch (error) {
    console.error('POSTGRESQL CONNECTION FAILED');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
