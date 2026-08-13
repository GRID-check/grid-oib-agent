/**
 * @vitest-environment node
 */
/**
 * The scope partition is one rule written in two places, so this pins both.
 *
 * `documents_session_requires_conversation` says where a session document is
 * filed: it has a conversation, nothing else does, and it has NO project. The
 * second half is the one a reader drops, because it does not follow from the
 * first — a row with `scope = 'session'`, a conversation AND a project passes
 * the biconditional while being a contradiction.
 *
 * It is also the half that costs data. `documents.project_id` is `ON DELETE
 * CASCADE`, so such a row would be deleted by a project purge WITHOUT going
 * through `deleteSessionDocument`, the only path that first purges the Chroma
 * chunks and the SeaweedFS objects. The row would go and the bytes would stay.
 *
 * Nothing violates it today — `uploadSessionDocument` passes `projectId: null`
 * — which is precisely why a test is worth more than the current green: the
 * invariant is held up by one careful function, and this is what notices when
 * the constraint that replaced that convention is weakened or when the drizzle
 * mirror and the migration drift apart.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { documents } from './documents'

const CONSTRAINT = 'documents_session_requires_conversation'

const MIGRATION = readFileSync(join(process.cwd(), 'drizzle/0049_session_documents.sql'), 'utf8')
const DOWN_MIGRATION = readFileSync(
  join(process.cwd(), 'drizzle/0049_session_documents.down.sql'),
  'utf8'
)

/**
 * One spelling for two dialects of the same expression: drizzle qualifies every
 * column with its table, the migration does not, and neither cares about case
 * or line breaks. Everything else — the operators, the operands, the grouping —
 * survives, which is the part that decides which rows are legal.
 */
function canonical(expression: string): string {
  return expression
    .replace(/"documents"\./g, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The whole rule, in the one form both sources must reduce to. */
const EXPECTED =
  "(scope = 'session') = (conversation_id is not null) and (scope <> 'session' or project_id is null)"

function migrationCheckBody(): string {
  const match = MIGRATION.match(
    new RegExp(`ADD CONSTRAINT "${CONSTRAINT}"\\s*CHECK\\s*\\(([\\s\\S]*?)\\)\\s*NOT VALID`)
  )
  if (!match) throw new Error(`migration 0049 declares no ${CONSTRAINT} CHECK`)
  return match[1]
}

function schemaCheckBody(): string {
  const check = getTableConfig(documents).checks.find((entry) => entry.name === CONSTRAINT)
  if (!check) throw new Error(`the drizzle table declares no ${CONSTRAINT} check`)
  return new PgDialect().sqlToQuery(check.value).sql
}

describe('the documents scope partition', () => {
  it('forbids a session row from also naming a project (migration 0049)', () => {
    // Without the `project_id IS NULL` half, `scope = 'session'` with a project
    // is a legal row — and deleting that project cascade-deletes it behind the
    // application's back, orphaning its object and its chunks.
    expect(canonical(migrationCheckBody())).toBe(EXPECTED)
  })

  it('states the same rule in the drizzle table, not a weaker one', () => {
    expect(canonical(schemaCheckBody())).toBe(EXPECTED)
  })

  it('keeps the two spellings identical', () => {
    // The pair is the point: a constraint the database enforces and a schema
    // that describes a different one is how a future `drizzle-kit generate`
    // silently proposes to relax it.
    expect(canonical(schemaCheckBody())).toBe(canonical(migrationCheckBody()))
  })

  it('is dropped by the down-migration under the same name', () => {
    expect(DOWN_MIGRATION).toContain(`DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`)
  })
})
