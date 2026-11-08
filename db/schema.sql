-- PayPerPrompt — durable replay protection + spend meter (Neon Postgres).
--
-- HOW TO APPLY (one time, before the redeploy):
--   1. Open the Neon console for project "neon-aqua-queen"
--      (the free project already connected to the scholarship-hunter
--      Vercel project — do NOT create a new Neon project).
--   2. Open the SQL Editor, paste this whole file, and run it.
--      (Or: psql "$DATABASE_URL" -f db/schema.sql from a machine that
--      has the connection string.)
--   3. In the PayPerPrompt Vercel project, set env var DATABASE_URL to
--      the pooled connection string of "neon-aqua-queen"
--      (Neon dashboard -> Connection Details -> pooled connection,
--      format: postgres://<user>:<password>@<host>/<db>?sslmode=require)
--      for Production AND Preview, then redeploy.
--
-- WHY: the old in-memory Set/Map lived in one serverless instance's
-- memory, so a replayed signature or a meter read landing on a different
-- instance was not caught (live re-verification: meter went 0.02 -> 0.01
-- and a replay returned 200 with a fresh summary). These tables are the
-- single source of truth across every instance.
--
-- Table names are namespaced payperprompt_* so they never collide with
-- the scholarship-hunter tables already in this database.

-- One row per redeemed payment. PRIMARY KEY makes the claim atomic:
-- a concurrent replay's INSERT fails with unique-violation (23505),
-- which the app turns into a 409. Rows are deleted only when the
-- Summarize tool fails, so a failed call never burns the payment.
CREATE TABLE IF NOT EXISTS payperprompt_used_signatures (
  signature TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per payer wallet with the total lamports charged so far.
-- The meter (spent / remaining) is always read from this table.
CREATE TABLE IF NOT EXISTS payperprompt_spend (
  payer TEXT PRIMARY KEY,
  spent_lamports BIGINT NOT NULL DEFAULT 0
);
