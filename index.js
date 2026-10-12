import { config } from '../config.js';
import sqliteDriver, { migrate as migrateSqlite, isEmpty as sqliteEmpty } from './sqlite.js';
import mysqlDriver, { migrate as migrateMysql, isEmpty as mysqlEmpty } from './mysql.js';

/**
 * A single data-access surface for both engines.
 *
 * Both drivers speak `?` placeholders and return plain row objects, so route
 * handlers are written once and run unchanged against SQLite (default, zero
 * setup) or MySQL 8 (set DB_DRIVER=mysql). Everything is awaited, which is a
 * no-op for the synchronous SQLite driver.
 */
const useMysql = config.dbDriver === 'mysql';

export const driverName = useMysql ? 'mysql' : 'sqlite';
export const db = useMysql ? mysqlDriver : sqliteDriver;
export const migrate = useMysql ? migrateMysql : migrateSqlite;
export const isEmpty = useMysql ? mysqlEmpty : sqliteEmpty;

/** Generates the next value for a named sequence (used for Patient IDs). */
export async function nextSequenceValue(entity, year) {
  if (useMysql) {
    await db.run(
      `INSERT INTO id_sequence (entity, year, current_value) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE current_value = IF(year = VALUES(year), current_value + 1, 1),
                               year = VALUES(year)`,
      [entity, year],
    );
    const row = await db.get(
      'SELECT current_value FROM id_sequence WHERE entity = ? AND year = ?',
      [entity, year],
    );
    return Number(row.current_value);
  }

  const row = await db.get(
    'SELECT year, current_value FROM id_sequence WHERE entity = ?',
    [entity],
  );
  if (!row) {
    await db.run(
      'INSERT INTO id_sequence (entity, year, current_value) VALUES (?, ?, 0)',
      [entity, year],
    );
    return 1;
  }
  if (Number(row.year) !== Number(year)) {
    await db.run('UPDATE id_sequence SET year = ?, current_value = 0 WHERE entity = ?', [
      year,
      entity,
    ]);
    return 1;
  }
  const next = Number(row.current_value) + 1;
  await db.run('UPDATE id_sequence SET current_value = ? WHERE entity = ?', [next, entity]);
  return next;
}

export default db;