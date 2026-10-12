import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.mysql,
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      supportBigNumbers: true,
      multipleStatements: true,
    });
  }
  return pool;
}

/** Applies db/schema.mysql.sql if the target database has no tables yet. */
export async function migrate() {
  const p = await getPool();
  const [rows] = await p.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'staff'`,
    [config.mysql.database],
  );
  if (Number(rows[0].n) > 0) return;

  const ddl = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'db', 'schema.mysql.sql'), 'utf8');
  // The DDL creates and selects the database, so it runs on a bare connection.
  const bare = await mysql.createConnection({ ...config.mysql, multipleStatements: true });
  await bare.query(ddl);
  await bare.end();
}

export async function isEmpty() {
  const p = await getPool();
  try {
    const [rows] = await p.query('SELECT COUNT(*) AS n FROM staff');
    return Number(rows[0].n) === 0;
  } catch {
    return true;
  }
}

function normalise(rows) {
  return rows.map((r) => ({ ...r }));
}

export const mysqlDriver = {
  name: 'mysql',

  async all(sql, params = []) {
    const p = await getPool();
    const [rows] = await p.query(sql, params);
    return normalise(rows);
  },

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0];
  },

  async run(sql, params = []) {
    const p = await getPool();
    const [info] = await p.query(sql, params);
    return {
      insertId: info.insertId ?? (Number(info.affectedRows) || 0),
      changes: info.affectedRows ?? 0,
    };
  },

  /** Runs `fn(conn)` inside a transaction. The conn exposes all()/get()/run(). */
  async transaction(fn) {
    const p = await getPool();
    const conn = await p.getConnection();
    try {
      await conn.beginTransaction();
      const scoped = {
        all: async (sql, params = []) => {
          const [rows] = await conn.query(sql, params);
          return normalise(rows);
        },
        get: async (sql, params = []) => {
          const [rows] = await conn.query(sql, params);
          return normalise(rows)[0];
        },
        run: async (sql, params = []) => {
          const [info] = await conn.query(sql, params);
          return { insertId: info.insertId ?? 0, changes: info.affectedRows ?? 0 };
        },
      };
      const out = await fn(scoped);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async close() {
    if (pool) await pool.end();
    pool = null;
  },
};

export default mysqlDriver;