/**
 * Shared shapes for the purger.
 *
 * The purger's modules are CommonJS on purpose: it runs as
 * `node purger/index.js`, with no build step and no loader hook, because the
 * process that erases a tenant should have as little between the source and
 * the running code as possible. That is a reason to be CommonJS. It was never
 * a reason to be UNCHECKED — `// @ts-check` and JSDoc give those files the same
 * compiler as the rest of the repo, and this file is where the types they refer
 * to live.
 *
 * A `.d.ts`, not a `.js` with typedefs: it is types only, so it emits nothing,
 * ships nothing, and cannot drift into carrying behaviour.
 */

/**
 * A `postgres` tagged-template client, in the one shape the purger uses it:
 * a template tag returning rows, callable inside or outside a transaction.
 *
 * Typed as `unknown[]` rather than a row union because each call site knows its
 * own shape and narrows it there — a shared row type would be a lie the moment
 * a query changed.
 */
export type Tx = <Row = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

/** A claimed `deletion_queue` row (ADR-0011). */
export interface QueueEntry {
  id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  attempts: number;
  /** Human-readable label, kept on the queue row so the log line survives the
   *  deletion of whatever it named. */
  display_name?: string | null;
  /** Snapshot taken at enqueue time, so a partial re-run can still find the
   *  pointers after the rows that held them are gone. */
  payload?: Record<string, unknown> | null;
}

/**
 * Everything a purger needs from the outside world, injected so the specs can
 * observe each destructive step rather than perform it.
 */
export interface PurgeDeps {
  backendUrl: string;
  internalToken: string;
  /** The deployment's shared bucket. Every other bucket a sweep visits is read
   *  from the document rows themselves (ADR-0043). */
  bucket: string;
  workos: {
    authorization: {
      deleteResourceByExternalId: (input: {
        organizationId: string;
        resourceTypeSlug: string;
        externalId: string;
        cascadeDelete: boolean;
      }) => Promise<unknown>;
    };
  };
  deleteStoragePrefix: (bucket: string, prefix: string) => Promise<number>;
  /** Overridden in specs; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** An error carrying the legal-hold sentinel the caller branches on. */
export interface LegalHoldError extends Error {
  code?: string;
}
