/**
 * The rows of a `db.execute(sql\`…\`)` result, as this deployment's driver
 * actually returns them.
 *
 * drizzle over postgres-js resolves `execute()` to postgres-js's `RowList`: an
 * ARRAY of row objects with `count`/`command` hung off it. node-postgres, the
 * other driver drizzle's docs show, resolves to `{ rows: [...] }`. Every raw
 * query in this codebase used to read `.rows`, which is `undefined` on an
 * array, and the `?? []` beside it turned that into "no rows" — so the
 * semantic duplicate gate in the memory service, which is raw SQL, never
 * matched a row in production while every mocked unit test passed
 * (`memory-service.integration.spec.ts` is the run that caught it).
 *
 * Deliberately NOT tolerant of `{ rows }`: accepting both shapes would let the
 * next mock encode the wrong one again with a green suite. A spec that stubs
 * `execute` returns an array, because that is what the driver returns.
 */
export function executeRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  throw new TypeError(
    '[db] execute() resolved to a non-array. This driver (postgres-js) returns a RowList; ' +
      'a `{ rows }` object is the node-postgres shape and means a stub, not the database.'
  )
}
