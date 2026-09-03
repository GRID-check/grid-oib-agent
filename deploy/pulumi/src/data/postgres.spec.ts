import { describe, it, expect } from "vitest";
import { CNPG_CHART_REPOSITORY, sslParamFor } from "./postgres";

describe("CNPG chart repository", () => {
  it("uses the GitHub-hosted chart index to avoid DNS redirects in CI", () => {
    expect(CNPG_CHART_REPOSITORY).toBe(
      "https://raw.githubusercontent.com/cloudnative-pg/charts/gh-pages",
    );
  });
});

/**
 * Every DSN this program emits asks for TLS, and the parameter that asks for it
 * has a different name depending on the driver reading it.
 *
 * This is worth a test because the failure mode is not the one you would guess.
 * Naming it wrong does not silently downgrade the connection to plaintext — it
 * refuses to connect at all, at runtime, on a stack that planned and applied
 * cleanly. `NAT_JOB_STORE_DB_URL` carried `?sslmode=require` to an asyncpg
 * client, SQLAlchemy's asyncpg dialect forwards query keys verbatim
 * (`opts.update(url.query)`), and `asyncpg.connect()` takes `ssl` with no
 * `**kwargs` — so the job store died on its first connection with an unexpected
 * keyword argument, in a tier whose failure looks like "jobs are not running".
 */
describe("sslParamFor", () => {
  it("gives asyncpg the parameter it actually accepts", () => {
    expect(sslParamFor("postgresql+asyncpg")).toBe("ssl");
  });

  it.each([
    ["the default libpq-shaped scheme", "postgresql"],
    ["psycopg", "postgresql+psycopg"],
    ["node-postgres / postgres-js", "postgres"],
  ])("gives %s `sslmode`", (_label, driver) => {
    expect(sslParamFor(driver)).toBe("sslmode");
  });

  it("keys on the driver, not on an exact scheme string", () => {
    // A future `postgresql+asyncpg` variant must not fall back to `sslmode`
    // just because the scheme gained a suffix.
    expect(sslParamFor("postgresql+asyncpg_something")).toBe("ssl");
  });
});
