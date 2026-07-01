import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let client: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

export function createDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const connectionString = process.env.GRID_APP_DATABASE_URL;

  if (!connectionString) {
    throw new Error("GRID_APP_DATABASE_URL is not defined");
  }

  client = postgres(connectionString, { prepare: false });
  dbInstance = drizzle(client);

  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    return createDb();
  }

  return dbInstance;
}

export async function closeDb() {
  if (client) {
    await client.end();
    client = null;
    dbInstance = null;
  }
}
