import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.GRID_APP_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("GRID_APP_DATABASE_URL is required");
}

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
