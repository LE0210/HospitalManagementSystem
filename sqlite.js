import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function open() {
  const file = config.sqlite.file;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA journal_mode = WAL');
  return handle;
}

const handle = open();

/** Applies the schema if the database is empty. Safe to call on every boot. */
export function migrate() {
  const ddl = fs.readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf8');
  handle.exec(ddl);
}

/** True when no data has been seeded yet. */
export function isEmpty() {
  try {
    const row = handle.prepare('SELECT COUNT(*) AS n FROM staff').get();
    return Number(row?.n ?? 0) === 0;
  } catch {
    return true;
  }
}

function clean(params = []) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export const sqliteDriver = {
  name: 'sqlite',

  all(sql, params = []) {
    return handle.prepare(sql).all(...clean(params));
  },

  get(sql, params = []) {
    return handle.prepare(sql).get(...clean(params));
  },

  run(sql, params = []) {
    const info = handle.prepare(sql).run(...clean(params));
    return { insertId: Number(info.lastInsertRowid), changes: Number(info.changes) };
  },

  /**
   * Runs `fn(scope)` inside a transaction, rolling back on any throw.
   * `scope` exposes the same all/get/run surface as the driver itself (SQLite
   * shares one connection, so it simply delegates), which keeps route handlers
   * identical across both engines.
   */
  transaction(fn) {
    const scope = {
      all: (sql, params) => sqliteDriver.all(sql, params),
      get: (sql, params) => sqliteDriver.get(sql, params),
      run: (sql, params) => sqliteDriver.run(sql, params),
    };
    handle.exec('BEGIN');
    try {
      const out = fn(scope);
      handle.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  },

  close() {
    handle.close();
  },
};

export default sqliteDriver;