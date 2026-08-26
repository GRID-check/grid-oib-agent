/**
 * @vitest-environment node
 */
/**
 * Rules about `documents` that are written in two places, pinned to each other.
 *
 * Every case here has the same shape: the database enforces something and the
 * drizzle table claims to describe it, and nothing makes the two agree. A
 * migration and a schema file that disagree is how a future `drizzle-kit
 * generate` silently proposes to relax a constraint nobody meant to touch.
 *
 * ## The scope partition (migration 0049)
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
 *
 * ## Authorship (migration 0063)
 *
 * `documents_authorship_requires_provenance` says a document no person wrote can
 * always name what wrote it and in which run. It is the columns' entire
 * justification: a row that says a machine did this and can answer neither
 * answers "who authorized this document" with a shrug, while looking like an
 * audit trail.
 *
 * It is written against `<> 'user'` rather than against `'agent'` so that a
 * member added to `DOCUMENT_AUTHORS` arrives constrained. That property is only
 * real if nothing re-specialises the constraint, which is what the last test in
 * that block is for.
 *
 * The index and the folder uniqueness are here for a different reason — both
 * are unrepresentable in drizzle (one partial, one over an expression), so the
 * only thing standing between them and a `drizzle-kit generate` that drops them
 * is a comment. These tests are what makes that comment load-bearing.
 *
 * ## The idempotency index (migrations 0064, 0065 and 0066)
 *
 * `uniq_documents_authored_ref_producer_per_project` is a third rule written in
 * two places, and the second place is not the schema file — it is
 * `findDocumentAuthoredByRef`. The index and that probe have to key on the same
 * columns or one of them is wrong, so the test reads BOTH sources instead of
 * comparing either to a literal.
 *
 * 0064 shipped that index without the producer, which allowed one machine-
 * authored document per run — impossible for a diagram, which is a previewable
 * SVG and an attachable PDF and needs both. 0065 widens the index and the probe
 * together, which is the move 0064's own header prescribes. 0066 restates it
 * under the renamed column rather than renaming it, precisely so the live rule
 * stays readable in ONE file — a renamed index has its columns in 0065 and its
 * name in 0066, and this test would have to reconstruct DDL to check it. So the
 * tests below read 0066 for the live rule and the two older files only to assert
 * that each index they created is gone.
 *
 * ## The reference and its kind (migration 0066)
 *
 * `authored_by_run_id` was documented as "the backend async job id of the run" and
 * held one for `deep_research` and `{chat answer}-{source hash}` for the two
 * diagram producers. 0066 renames it to `authored_by_ref` and adds
 * `authored_by_ref_kind`, so the row states what its identifier IS rather than
 * leaving a reader to assume — and the CHECK grows a third conjunct, because two
 * of them were satisfiable by a row nobody could resolve.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { AUTHORED_REF_KINDS, DOCUMENT_AUTHORS, documents } from './documents'
import { GENERATED_DOCUMENT_PRODUCER_REF_KINDS } from '@/lib/documents/generated'
import { projectFolders } from './project-folders'
import { IN_FLIGHT_DOCUMENT_STATUSES } from '@/lib/documents/document-status'

const CONSTRAINT = 'documents_session_requires_conversation'

const MIGRATION = readFileSync(join(process.cwd(), 'drizzle/0049_session_documents.sql'), 'utf8')
const DOWN_MIGRATION = readFileSync(
  join(process.cwd(), 'drizzle/0049_session_documents.down.sql'),
  'utf8'
)

const AUTHORSHIP_CONSTRAINT = 'documents_authorship_requires_provenance'

const MIGRATION_0063 = readFileSync(
  join(process.cwd(), 'drizzle/0063_agent_authored_documents.sql'),
  'utf8'
)
const DOWN_MIGRATION_0063 = readFileSync(
  join(process.cwd(), 'drizzle/0063_agent_authored_documents.down.sql'),
  'utf8'
)

const MIGRATION_0064 = readFileSync(
  join(process.cwd(), 'drizzle/0064_generated_document_idempotency.sql'),
  'utf8'
)
const DOWN_MIGRATION_0064 = readFileSync(
  join(process.cwd(), 'drizzle/0064_generated_document_idempotency.down.sql'),
  'utf8'
)
const MIGRATION_0065 = readFileSync(
  join(process.cwd(), 'drizzle/0065_diagram_document_producer_idempotency.sql'),
  'utf8'
)
const DOWN_MIGRATION_0065 = readFileSync(
  join(process.cwd(), 'drizzle/0065_diagram_document_producer_idempotency.down.sql'),
  'utf8'
)
const MIGRATION_0066 = readFileSync(
  join(process.cwd(), 'drizzle/0066_authored_ref_names_its_kind.sql'),
  'utf8'
)
const DOWN_MIGRATION_0066 = readFileSync(
  join(process.cwd(), 'drizzle/0066_authored_ref_names_its_kind.down.sql'),
  'utf8'
)

/**
 * The repository's SOURCE, read rather than imported: it is a `server-only`
 * module and a schema spec has no business booting one. The same arrangement
 * `document-status.spec.ts` uses on the poller.
 */
const DOCUMENTS_REPOSITORY = readFileSync(
  join(process.cwd(), 'src/lib/documents/repository.ts'),
  'utf8'
)

const IDEMPOTENCY_INDEX = 'uniq_documents_authored_ref_producer_per_project'
/** 0064's, which 0065 subsumes. Named so the pair of tests below can say so. */
const SUPERSEDED_INDEX = 'uniq_documents_authored_run_per_project'
/** 0065's, which 0066 restates under the renamed column. */
const RENAMED_INDEX = 'uniq_documents_authored_run_producer_per_project'

/**
 * A statement that actually RUNS — anchored to the start of a line, so a
 * commented-out `-- DROP INDEX …` does not satisfy an assertion about a drop.
 * These migrations quote their own index names in prose, at length, on purpose.
 */
function statement(sql: string): RegExp {
  return new RegExp(`^${sql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')
}

/** The column list of a `CREATE [UNIQUE] INDEX`, in declaration order. */
function indexColumns(migration: string, name: string): string[] {
  const match = migration.match(
    new RegExp(`CREATE UNIQUE INDEX "${name}"\\s*ON "documents" \\(([^)]*)\\)`)
  )
  if (!match) throw new Error(`the migration declares no ${name}`)
  return match[1].split(',').map((column) => column.trim().replace(/"/g, ''))
}

/**
 * The columns `findDocumentAuthoredByRef` filters by, read out of its own body.
 *
 * Scoped to that one function — from its `export` to the next one — so a
 * neighbouring query's WHERE clause cannot make this pass.
 */
function probeColumns(): string[] {
  const start = DOCUMENTS_REPOSITORY.indexOf('export async function findDocumentAuthoredByRef')
  expect(start, 'findDocumentAuthoredByRef still exists').toBeGreaterThan(-1)
  const rest = DOCUMENTS_REPOSITORY.slice(start + 1)
  const end = rest.indexOf('export async function')
  const body = end === -1 ? rest : rest.slice(0, end)
  return [...body.matchAll(/eq\(documents\.(\w+),/g)]
    .map(([, column]) => column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
    .sort()
}

/**
 * The authorship predicate `findDocumentAuthoredByRef` applies, read out of its
 * own body — the half of the index that is NOT a key column.
 *
 * Separate from `probeColumns` because the two halves are different claims. The
 * key columns say what the index is ON; the predicate says which rows it covers,
 * and 0064's rule ("an index narrower than the probe rejects rows the probe
 * accepts, an index wider than it admits duplicates") is about BOTH. The
 * columns matched for a year while the predicate did not, and the test that was
 * supposed to catch drift compared only the columns.
 */
function probeAuthorshipPredicate(): string | null {
  const start = DOCUMENTS_REPOSITORY.indexOf('export async function findDocumentAuthoredByRef')
  expect(start, 'findDocumentAuthoredByRef still exists').toBeGreaterThan(-1)
  const rest = DOCUMENTS_REPOSITORY.slice(start + 1)
  const end = rest.indexOf('export async function')
  const body = end === -1 ? rest : rest.slice(0, end)
  // Comments in the body name the predicate too; only a real call counts.
  const uncommented = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  return /ne\(documents\.authoredBy,\s*'user'\)/.test(uncommented)
    ? "<> 'user'"
    : /eq\(documents\.authoredBy,\s*'agent'\)/.test(uncommented)
      ? "= 'agent'"
      : null
}

/**
 * The poller's in-flight set.
 *
 * It used to be read out of `reconcile-status.ts` with a regex, because the
 * poller declared its own Set literal and the module pulls in `server-only`
 * through the repository, which a schema spec has no business booting. The set
 * is now DECLARED once in `@/lib/documents/document-status` — a pure data
 * module with no server imports — and the poller derives it from there, so the
 * spec asks the declaration directly. That `reconcile-status.ts` really does
 * derive rather than restate is pinned by `document-status.spec.ts`.
 */
function inFlightStatuses(): string[] {
  return [...IN_FLIGHT_DOCUMENT_STATUSES]
}

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

function migrationCheckBody(source: string, constraint: string): string {
  const match = source.match(
    new RegExp(`ADD CONSTRAINT "${constraint}"\\s*CHECK\\s*\\(([\\s\\S]*?)\\)\\s*NOT VALID`)
  )
  if (!match) throw new Error(`the migration declares no ${constraint} CHECK`)
  return match[1]
}

function schemaCheckBody(constraint: string): string {
  const check = getTableConfig(documents).checks.find((entry) => entry.name === constraint)
  if (!check) throw new Error(`the drizzle table declares no ${constraint} check`)
  return new PgDialect().sqlToQuery(check.value).sql
}

describe('the documents scope partition', () => {
  it('forbids a session row from also naming a project (migration 0049)', () => {
    // Without the `project_id IS NULL` half, `scope = 'session'` with a project
    // is a legal row — and deleting that project cascade-deletes it behind the
    // application's back, orphaning its object and its chunks.
    expect(canonical(migrationCheckBody(MIGRATION, CONSTRAINT))).toBe(EXPECTED)
  })

  it('states the same rule in the drizzle table, not a weaker one', () => {
    expect(canonical(schemaCheckBody(CONSTRAINT))).toBe(EXPECTED)
  })

  it('keeps the two spellings identical', () => {
    // The pair is the point: a constraint the database enforces and a schema
    // that describes a different one is how a future `drizzle-kit generate`
    // silently proposes to relax it.
    expect(canonical(schemaCheckBody(CONSTRAINT))).toBe(
      canonical(migrationCheckBody(MIGRATION, CONSTRAINT))
    )
  })

  it('is dropped by the down-migration under the same name', () => {
    expect(DOWN_MIGRATION).toContain(`DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`)
  })
})

/**
 * The whole authorship rule, in the one form both sources must reduce to.
 * One-directional on purpose: a `user` row carrying a producer and a run id is
 * legal, and a biconditional here would reject a person saving an artefact a run
 * showed them while protecting nothing.
 */
const EXPECTED_AUTHORSHIP =
  "authored_by = 'user' or (authored_by_producer is not null and authored_by_ref is not null and authored_by_ref_kind is not null)"

describe('authorship on documents', () => {
  it('makes a row no person wrote name its producer, its reference AND what that reference is', () => {
    // Without it, `authored_by = 'agent'` with NULLs is a legal row: the
    // enterprise answer to "who authorized this document" becomes "a machine",
    // which is not an answer, and the columns stop being auditable while still
    // looking like they are.
    //
    // The THIRD conjunct is 0066's, and it is the one this file would otherwise
    // let slip. 0063's two were satisfiable by a row whose reference nobody
    // could resolve — a diagram's `{chat answer}-{source hash}` sitting in a
    // column called `authored_by_run_id` whose comment said backend job id — so
    // the constraint passed while guaranteeing nothing it was written to
    // guarantee. The live rule is read from 0066, which is where it now is.
    expect(canonical(migrationCheckBody(MIGRATION_0066, AUTHORSHIP_CONSTRAINT))).toBe(
      EXPECTED_AUTHORSHIP
    )
  })

  it('states the same rule in the drizzle table, not a weaker one', () => {
    expect(canonical(schemaCheckBody(AUTHORSHIP_CONSTRAINT))).toBe(EXPECTED_AUTHORSHIP)
  })

  it('keeps the two spellings identical', () => {
    expect(canonical(schemaCheckBody(AUTHORSHIP_CONSTRAINT))).toBe(
      canonical(migrationCheckBody(MIGRATION_0066, AUTHORSHIP_CONSTRAINT))
    )
  })

  it('is dropped by the down-migration under the same name', () => {
    expect(DOWN_MIGRATION_0063).toContain(`DROP CONSTRAINT IF EXISTS "${AUTHORSHIP_CONSTRAINT}"`)
    expect(DOWN_MIGRATION_0066).toContain(`DROP CONSTRAINT IF EXISTS "${AUTHORSHIP_CONSTRAINT}"`)
  })

  it('replaces 0063\u2019s constraint rather than adding a second one', () => {
    // One name, one rule. A second constraint under a different name would let
    // the weaker of the two be dropped without anything noticing, and both would
    // report success for a row that satisfies only the weaker.
    expect(MIGRATION_0066).toMatch(
      statement(`ALTER TABLE \"documents\" DROP CONSTRAINT \"${AUTHORSHIP_CONSTRAINT}\"`)
    )
  })

  it('records what kind of identifier the reference is, and derives it from the producer', () => {
    // The backfill is what makes 0066 safe on data that already exists, and it
    // is keyed on `authored_by_producer` because that is the one column that
    // answers the question exactly. A migration that guessed instead would write
    // a false statement into the record the whole feature exists to make
    // truthful — so the guard above it refuses on a producer it has no kind for.
    expect(MIGRATION_0066).toMatch(/UPDATE \"documents\"[\s\S]*?CASE \"authored_by_producer\"/)
    const guard = MIGRATION_0066.indexOf('RAISE EXCEPTION')
    const backfill = MIGRATION_0066.indexOf('UPDATE \"documents\"')
    expect(guard).toBeGreaterThan(-1)
    expect(backfill).toBeGreaterThan(guard)
  })

  it('backfills the same producer\u2192kind table the filing path reads', () => {
    // 0066's header rests the whole change on these two tables agreeing:
    // "a wrong `authored_by_ref_kind` is worse than a missing column, because
    // it is a false statement in the record this whole change exists to make
    // truthful". Nothing compared them. Changing the SQL's `diagram_svg` to
    // `agent_run` left this file green, and applying that migration to a
    // database holding a pre-0066 diagram row wrote `agent_run` onto a chat
    // answer's artifact id — reachable on real data, because 0065 ships before
    // 0066 and diagram rows can already exist when it runs.
    const backfill = MIGRATION_0066.slice(MIGRATION_0066.indexOf('CASE "authored_by_producer"'))
    const mapped = Object.fromEntries(
      [...backfill.slice(0, backfill.indexOf('END')).matchAll(/WHEN '(\w+)' THEN '(\w+)'/g)].map(
        ([, producer, kind]) => [producer, kind]
      )
    )
    expect(mapped).toEqual(GENERATED_DOCUMENT_PRODUCER_REF_KINDS)
  })

  it('refuses exactly the producers it cannot backfill, and no others', () => {
    // The guard's allow-list and the CASE's arms are one list written twice. A
    // producer added to the guard but not to the CASE passes the refusal, gets
    // a NULL kind, and then dies at `VALIDATE CONSTRAINT` — turning a designed
    // exception that names the producer into a bare constraint violation, which
    // is the opposite of "a migration that cannot know an answer must stop and
    // say so".
    const guard = MIGRATION_0066.slice(0, MIGRATION_0066.indexOf('RAISE EXCEPTION'))
    const allowList = /NOT IN \(([^)]*)\)/.exec(guard)?.[1] ?? ''
    const guarded = [...allowList.matchAll(/'(\w+)'/g)].map(([, producer]) => producer).sort()
    expect(guarded).toEqual(Object.keys(GENERATED_DOCUMENT_PRODUCER_REF_KINDS).sort())
  })

  it('gives every producer a reference kind, so none can be filed unresolvable', () => {
    // The map in `generated.ts` is what the filing path reads, and this is the
    // half of it a spec can hold: a producer with no entry cannot be filed at
    // all (the lookup is a compile error), and a kind outside the tuple cannot
    // be written. Read from the vocabulary rather than a literal, so adding a
    // kind without adding it to `AUTHORED_REF_KINDS` fails here.
    for (const kind of Object.values(GENERATED_DOCUMENT_PRODUCER_REF_KINDS)) {
      expect(AUTHORED_REF_KINDS).toContain(kind)
    }
    expect(Object.keys(GENERATED_DOCUMENT_PRODUCER_REF_KINDS).length).toBeGreaterThan(0)
  })

  it('exempts the one author that IS its own provenance, and nothing else', () => {
    // The exemption is `user` because a person is the provenance — `created_by`
    // already names them. Every other member has to earn its row, and the tuple
    // is what every caller enumerates, so a rename that reaches TypeScript and
    // not the column default produces rows the constraint reads differently
    // from the code.
    const column = getTableConfig(documents).columns.find((entry) => entry.name === 'authored_by')
    expect(column?.default).toBe(DOCUMENT_AUTHORS[0])
    expect(DOCUMENT_AUTHORS[0]).toBe('user')
  })

  it('names no producer, so a new author arrives already constrained', () => {
    // This is the growable seam, asserted rather than hoped for. The moment the
    // constraint mentions a specific producer it stops covering the next one,
    // and the failure is silent: a `system` row with no run id would simply be
    // legal, and the audit answer for it would be a shrug that looks like a
    // record.
    const body = canonical(schemaCheckBody(AUTHORSHIP_CONSTRAINT))
    for (const author of DOCUMENT_AUTHORS.slice(1)) {
      expect(body).not.toContain(`'${author}'`)
    }
  })
})

describe('the indexes drizzle cannot declare', () => {
  it('keeps documents_agent_authored_idx partial, and only in the migration', () => {
    // Declaring it in the schema file is not an option — drizzle's builder has
    // no WHERE — so declaring it there ANYWAY would produce a full index over a
    // table that is overwhelmingly human uploads, to serve a lookup that only
    // ever asks about the few agent rows. Same arrangement, same reason, as
    // `documents_conversation_idx`.
    const declared = getTableConfig(documents).indexes.map((entry) => entry.config.name)
    expect(declared).not.toContain('documents_agent_authored_idx')
    expect(MIGRATION_0063).toMatch(
      /CREATE INDEX "documents_agent_authored_idx"\s*ON "documents" \("project_id", "created_at" DESC\)\s*WHERE "authored_by" = 'agent'/
    )
  })

  it('drops it again on the way down', () => {
    expect(DOWN_MIGRATION_0063).toContain('DROP INDEX IF EXISTS "documents_agent_authored_idx"')
  })

  it('keeps uniq_project_folders_parent_name COALESCE-keyed, and only in the migration', () => {
    // An expression index, so drizzle cannot hold it either. The COALESCE is
    // the part a rewrite drops: without it NULL never equals NULL, so root
    // folders — which is where a fixed, created-on-first-use `Berichte` lands —
    // are the one case the index would stop protecting, and it would still look
    // like it was doing its job everywhere else.
    const declared = [
      ...getTableConfig(projectFolders).indexes.map((entry) => entry.config.name),
      ...getTableConfig(projectFolders).uniqueConstraints.map((entry) => entry.name),
    ]
    expect(declared).not.toContain('uniq_project_folders_parent_name')
    expect(MIGRATION_0063).toMatch(
      /CREATE UNIQUE INDEX "uniq_project_folders_parent_name"[\s\S]*?coalesce\("parent_id"/
    )
  })

  it('refuses to build the folder index before it has looked for duplicates', () => {
    // Nothing has ever stopped two sibling folders sharing a name, so a
    // deployment may already have some. Postgres would refuse with one key and
    // leave the operator to find the rest; the guard fails first with the whole
    // list, and deliberately does not deduplicate — deleting a folder row
    // cascades to `documents.folder_id` and would unfile real evidence.
    const guard = MIGRATION_0063.indexOf('RAISE EXCEPTION')
    const create = MIGRATION_0063.indexOf('CREATE UNIQUE INDEX "uniq_project_folders_parent_name"')
    expect(guard).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(guard)
  })

  it('drops the folder index again on the way down', () => {
    expect(DOWN_MIGRATION_0063).toContain('DROP INDEX IF EXISTS "uniq_project_folders_parent_name"')
  })
})

/**
 * ONE FILED REPORT PER RUN, AS A CONSTRAINT (migration 0064).
 *
 * 0063 shipped the filing path with idempotency implemented as a probe:
 * `findDocumentAuthoredByRun` runs before the render, and a hit short-circuits.
 * A lookup cannot see a caller that has not inserted yet, and the filing write
 * sits on a GET that is re-fetched every time the report tab is opened — so two
 * tabs both probe, both miss, and both file. The two rows are then IDENTICAL in
 * every visible attribute, because the generated filename is deterministic (slug
 * + date + extension): same name, size, folder, author, run and second. The
 * repository already called that "precisely the thing an office cannot untangle
 * later" and then left a lookup to prevent it.
 *
 * These tests are about the index and the probe agreeing. That agreement is the
 * whole design: an index NARROWER than the probe rejects rows the probe would
 * accept (and the caller's 23505 recovery finds no winner to hand back), while
 * an index WIDER than it admits the duplicate the probe was meant to prevent and
 * reports success. Neither failure shows up in a status code.
 */
describe('the idempotency index and the probe it belongs to', () => {
  it('keys on exactly the columns the probe filters by', () => {
    // Read from both sources rather than from a literal, because a literal would
    // simply be a third place to keep in step. If somebody re-scopes the probe —
    // as 0063 already had to once, adding `project_id` after an org-wide probe
    // handed back another project's document — this is what makes them change
    // the index in the same commit.
    expect(indexColumns(MIGRATION_0066, IDEMPOTENCY_INDEX).sort()).toEqual(probeColumns())
  })

  it('found real columns on both sides, not two empty lists', () => {
    // Half the assertion above is that the two scans found anything at all: two
    // empty lists are equal, and would pass it for the worst possible reason.
    expect(probeColumns()).toEqual([
      'authored_by_producer',
      'authored_by_ref',
      'organization_id',
      'project_id',
    ])
  })

  it('is UNIQUE and partial on <> user, so a human row is never rejected', () => {
    // 0063's CHECK is one-directional on purpose: a `user` row MAY carry a
    // producer and a run id, because a person saving an artefact a run showed
    // them is not a contradiction. Without the predicate, two colleagues saving
    // one run's artefact into one project would collide with each other — an
    // index built to stop a machine racing itself rejecting an ordinary human
    // action. `<> 'user'` rather than `= 'agent'` for 0063's reason: the next
    // producer arrives already constrained.
    expect(MIGRATION_0066).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${IDEMPOTENCY_INDEX}"\\s*ON "documents" \\([^)]*\\)\\s*WHERE "authored_by" <> 'user'`
      )
    )
  })

  it('applies the index\u2019s predicate in the probe too, not only its columns', () => {
    // The half of the agreement that was never checked. Without it the probe is
    // WIDER than the index — 0064's dangerous direction — and a `user` row
    // carrying a producer and a reference answers it. 0063's CHECK permits that
    // row deliberately, and the index is partial precisely because of it, so the
    // shape is legal and reachable rather than theoretical: the caller is told
    // `alreadyFiled` and handed a human document's id, and the report that was
    // commissioned is never written.
    //
    // `<> 'user'` and not `= 'agent'`, matching the index, for 0063's reason:
    // a producer added later arrives already constrained instead of slipping
    // through a deny-list nobody remembered to extend.
    expect(probeAuthorshipPredicate()).toBe("<> 'user'")
  })

  it('lives only in the migration, like every other partial index here', () => {
    // Drizzle's builder can express neither the predicate nor a unique partial
    // index, so declaring it in the schema file would produce a FULL unique
    // index over a table that is overwhelmingly human uploads — which would
    // reject the legal `user` rows above outright.
    const declared = [
      ...getTableConfig(documents).indexes.map((entry) => entry.config.name),
      ...getTableConfig(documents).uniqueConstraints.map((entry) => entry.name),
    ]
    expect(declared).not.toContain(IDEMPOTENCY_INDEX)
  })

  it('replaces 0064\u2019s index rather than standing beside it', () => {
    // Two unique indexes over the same rows, one of them narrower, is the
    // narrower one silently deciding the rule. 0064's has to GO in the same
    // migration that widens it, or a diagram's second artifact is rejected by
    // an index nothing points at any more.
    //
    // Line-anchored, not `toContain`: 0065's header QUOTES the old index name
    // several times while explaining why it is going, and a `DROP` that has
    // been commented out contains the same substring as one that runs.
    expect(MIGRATION_0064).toMatch(statement(`CREATE UNIQUE INDEX "${SUPERSEDED_INDEX}"`))
    expect(MIGRATION_0065).toMatch(statement(`DROP INDEX IF EXISTS "${SUPERSEDED_INDEX}"`))
    expect(MIGRATION_0065).not.toMatch(statement(`CREATE UNIQUE INDEX "${SUPERSEDED_INDEX}"`))
  })

  it('leaves no index behind under the name 0066 renamed away from', () => {
    // 0066 could have renamed 0065's index and been done in a catalog update.
    // It restates it instead, so the live rule is readable in one file — and the
    // half that makes that safe is this one: the old name has to GO, or the
    // table carries two unique indexes over the same rows and a reader has two
    // candidate rules with no way to tell which is current.
    expect(MIGRATION_0066).toMatch(statement(`CREATE UNIQUE INDEX "${IDEMPOTENCY_INDEX}"`))
    expect(MIGRATION_0066).toMatch(statement(`DROP INDEX IF EXISTS "${RENAMED_INDEX}"`))
    expect(MIGRATION_0066).not.toMatch(/^ALTER INDEX/m)
  })

  it('needs no duplicate guard going up, and has one coming down', () => {
    // 0063 and 0064 both refuse to build over violating data because their
    // indexes were NARROWER than what the table already allowed. 0065's is
    // strictly wider, so a guard there could not fire. Rolling back narrows,
    // and THAT can fail on real data — a diagram that filed both artifacts is
    // two rows 0064's key cannot tell apart — so the guard lives in the down
    // migration, ahead of the create, and does not choose which row to delete.
    expect(MIGRATION_0065).not.toContain('RAISE EXCEPTION')
    const guard = DOWN_MIGRATION_0065.indexOf('RAISE EXCEPTION')
    const create = DOWN_MIGRATION_0065.indexOf(`CREATE UNIQUE INDEX "${SUPERSEDED_INDEX}"`)
    expect(guard).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(guard)
  })

  it('drops it again on the way down, and restores the one it replaced', () => {
    // Each down migration restores exactly the index its own up migration
    // replaced: 0066 goes back to 0065's name over the renamed column, 0065 back
    // to 0064's narrower key.
    expect(DOWN_MIGRATION_0066).toMatch(statement(`DROP INDEX IF EXISTS "${IDEMPOTENCY_INDEX}"`))
    expect(DOWN_MIGRATION_0066).toMatch(statement(`CREATE UNIQUE INDEX "${RENAMED_INDEX}"`))
    expect(DOWN_MIGRATION_0065).toMatch(statement(`DROP INDEX IF EXISTS "${RENAMED_INDEX}"`))
    expect(DOWN_MIGRATION_0065).toMatch(statement(`CREATE UNIQUE INDEX "${SUPERSEDED_INDEX}"`))
    expect(DOWN_MIGRATION_0064).toContain(`DROP INDEX IF EXISTS "${SUPERSEDED_INDEX}"`)
  })

  it('refuses to roll 0066 back over a reference that is not a run', () => {
    // The down direction restores a column named `authored_by_run_id` and drops
    // the kind, so a diagram's reference would go back under a name that
    // misdescribes it — which is the exact failure 0066 exists to remove, and
    // the value also rides the `document.generated` audit event as an
    // `agent_run` target id. The guard names the rows and does not delete them:
    // they carry real bytes and a real quota charge.
    expect(MIGRATION_0066).not.toMatch(/^\s*RAISE EXCEPTION[\s\S]*roll back/m)
    const guard = DOWN_MIGRATION_0066.indexOf('RAISE EXCEPTION')
    const rename = DOWN_MIGRATION_0066.indexOf('RENAME COLUMN')
    expect(guard).toBeGreaterThan(-1)
    expect(rename).toBeGreaterThan(guard)
  })
})

describe('a stored document is terminal', () => {
  it('is never polled, because the poller has no in-flight entry for it', () => {
    // `stored` means the bytes are here and indexing was deliberately skipped,
    // so there is no ingestion job to ask about. Putting it in the in-flight set
    // would make every read of the row query a backend that has never heard of
    // it and then overwrite the status from a collection file list that will
    // never contain it — the row would flip to `failed` on its own.
    expect(inFlightStatuses()).not.toContain('stored')
  })

  it('leaves the states that ARE in flight alone', () => {
    // Half the assertion above is that the regex found the real set rather than
    // an empty one, which would pass the `not.toContain` for the wrong reason.
    expect(inFlightStatuses()).toContain('pending')
  })
})
