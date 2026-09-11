-- One-time setup for the D1 database bound as BUS_CACHE.
-- Run via: npx wrangler d1 execute <your-db-name> --remote --file=./schema.sql
-- (or paste this into the dashboard's D1 database -> Console tab).
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
