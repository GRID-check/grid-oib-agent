import { defineConfig } from "drizzle-kit";

/**
 * Migrations connect as the SCHEMA OWNER, not as the runtime role (ADR-0041).
 *
 * `GRID_APP_DATABASE_URL` now points at `grid_app_rw`, which holds DML only and
 * is subject to row-level security — correct for serving requests, useless for
 * DDL, and actively dangerous for a data backfill, which would silently touch
 * zero rows. `GRID_APP_MIGRATION_DATABASE_URL` carries the owner credential and
 * is set only on the workload that runs migrations.
 *
 * It falls back to `GRID_APP_DATABASE_URL` so a local checkout pointed at a
 * throwaway database keeps working with one variable.
 */
const databaseUrl =
  process.env.GRID_APP_MIGRATION_DATABASE_URL ?? process.env.GRID_APP_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("GRID_APP_MIGRATION_DATABASE_URL or GRID_APP_DATABASE_URL is required");
}

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
