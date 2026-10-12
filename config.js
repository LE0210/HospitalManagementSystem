import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
export const SERVER_ROOT = path.resolve(__dirname, '..');

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),

  // 'sqlite' (default, zero-setup) or 'mysql'
  dbDriver: (process.env.DB_DRIVER || 'sqlite').toLowerCase(),

  sqlite: {
    file: process.env.SQLITE_FILE || path.join(SERVER_ROOT, 'data', 'hms.db'),
  },

  mysql: {
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hms',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'hms-dev-secret-change-in-production',
    // 30 minutes of inactivity, per SCR-01 security notes.
    expiresIn: process.env.JWT_EXPIRES_IN || '30m',
  },

  security: {
    maxFailedLogins: int(process.env.MAX_FAILED_LOGINS, 5),
    lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),
  },

  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Hospital trading date used by the prototype (matches the Figma mock-ups).
  systemDate: process.env.SYSTEM_DATE || '2026-05-12',
};

export const isProd = config.env === 'production';

if (isProd && config.jwt.secret.startsWith('hms-dev-secret')) {
  throw new Error('JWT_SECRET must be set in production.');
}