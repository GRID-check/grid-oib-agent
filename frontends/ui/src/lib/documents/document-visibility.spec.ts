/**
 * The hold is a reader every query states, not a status every reader remembers
 * (ADR-0083, amended 2026-10-08).
 *
 * Three repair rounds on the quarantine each found readers of `documents` that
 * forgot to check `status = 'quarantined'`: the project overview, the name
 * probes, the IFC model list, document roles, the sharing registry, the version
 * workflow, delete and move, the status read, the agent's version read. Each
 * was fixed where it was found, and the next round found the next one, because
 * nothing failed for a query that did not ask.
 *
 * This spec is the thing that fails. Every query that selects from the
 * `documents` table (a `from`, any join, `db.query.documents`, or raw SQL that
 * reads `FROM documents` / `JOIN documents`) must sit in a function that
 * composes `documentVisibleTo` (`./visibility`), directly or through a helper
 * in the same module. A query that must see every row (a sweep, a quota sum,
 * the reviewers' queue, a check for orphans) is named in {@link SEES_EVERY_ROW}
 * with the reason it is safe, and an entry that no longer matches a query fails
 * too, so the list cannot rot into a blanket exemption.
 *
 * Parsed with the TypeScript compiler, like `server-component-db-access.spec.ts`:
 * a regex over source text cannot tell `documents` the table from `documents`
 * the array, and cannot find the function a query sits in.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')
const PREDICATE = 'documentVisibleTo'

/**
 * Queries over `documents` that see every row, held ones included, keyed
 * `<path under src>#<function>`. Each says why that is safe; an entry is a
 * review question, not a convenience.
 */
const SEES_EVERY_ROW: Record<string, string> = {
  // --- The quarantine itself -------------------------------------------------
  'lib/documents/repository.ts#listQuarantinedDocuments':
    "The reviewers' queue: held rows are what it lists, and `listQuarantineQueue` authorizes each row with `mayReviewQuarantine`.",

  // --- Sweeps over every organization or every stuck row ---------------------
  'lib/documents/repository.ts#listStuckProcessingDocuments':
    'Sweep: re-dispatches rows left at `processing`, which are held by definition. Returns ids to a worker, nothing to a person.',
  'lib/documents/repository.ts#listFailedDocumentPageInOrg':
    'Sweep: the failed-ingestion rescan re-dispatches each id through `reingestDocument`. Ids only, to a job.',
  'lib/platform/vector-reconcile.ts#liveFilenamesByCollection':
    'Sweep: which filenames still have a row, so chunks of deleted documents are purged. A held row is not deleted.',
  'lib/session-documents/repository.ts#listSessionDocumentsForCleanup':
    "Discarding a chat erases every attachment's objects, held ones first among them.",

  // --- Orphan checks: a held document is not gone ---------------------------
  'lib/documents/repository.ts#documentIdsExisting':
    "The sharing registry's `exists`: the orphan sweep deletes grants of documents that are gone, and a held one is not.",
  'lib/documents/repository.ts#listDocumentIdsForProject':
    "The sharing registry's `listIdsInProject`: a leaver's grants go on every document of the project, held ones included.",
  'lib/sharing/repository.ts#deleteOrphanedGrants': 'Orphan sweep: NOT EXISTS over every row, or a held document loses its grants.',
  'lib/inbox/repository.ts#deleteOrphanedInboxItems': 'Orphan sweep: NOT EXISTS over every row, or a held document loses its inbox rows.',
  'lib/mentions/repository.ts#deleteOrphanedMentionRequests':
    'Orphan sweep: NOT EXISTS over every row, or a held document loses its mention requests.',
  'lib/documents/version-repository.ts#keyIsUnnamed':
    "Whether any row still names an object before it is deleted: a held row's object must not be.",
  'lib/projects/cleanup-repository.ts#deleteEmptyCreatedFolder':
    'Undo of a clean-out: removes a folder only when NO document is filed in it, held ones included.',

  // --- Storage accounting: every byte counts --------------------------------
  'lib/storage/repository.ts#aggregateStorageUsage': 'Quota: a held file occupies storage like any other (ADR-0083, Consequences).',
  'lib/storage/repository.ts#aggregateStorageUsageByOrganization': 'Quota, per organization, for the platform view: every byte.',
  'lib/storage/repository.ts#readStorageUsage': 'Quota admission under the lock: every byte, or a held upload is free storage.',
  'lib/storage/repository.ts#sumItemBytes': 'Quota: item bytes, every row.',
  'lib/storage/repository.ts#versionOverheadByScope': 'Quota: version bytes, every row.',
  'lib/storage/repository.ts#versionOverheadBytes': 'Quota: version bytes, every row.',
  'lib/storage/repository.ts#versionOverheadSql': 'Quota: the version-overhead fragment the sums above share.',

  // --- Placement and the Papierkorb move every document of a folder ---------
  'lib/projects/collection-placement.ts#listPlacementRows':
    "Placement moves every document whose folder's access changed into the right collection, held ones too, or a held file stays in a collection readers it should not have can search once it passes.",
  'lib/projects/folder-bin-repository.ts#listDocumentIdsInFolders': 'The Papierkorb moves a folder with every document in it.',
  'lib/projects/folder-bin-repository.ts#listDocumentsInFolders': 'The Papierkorb purges and restores every document of a folder.',
  'lib/projects/folder-bin-repository.ts#listBinEntries':
    "The Papierkorb's count of what a binned folder holds; restoring it brings every document back, held ones included.",
  'lib/projects/folder-derived-repository.ts#listReportsDerivedFrom':
    "Piloti's own reports drawn from a purged folder: the purge marks every one of them, and none of them is an upload.",
  'lib/authz/folder-access-repository.ts#listProjectDocumentCollections':
    'Which retrieval collections a project uses, for folder access decisions. Collection names, never a document.',
  'lib/authz/folder-access-repository.ts#countIfcDocumentsInFolders':
    'Refuses restricting a folder that holds an IFC model, held or not: the guard is about the building data, which exists either way.',

  // --- The upload machinery's own bookkeeping --------------------------------
  'lib/upload-batches/repository.ts#batchIdsOfDocuments': 'The settle hook: which batches the rows a reconcile moved belong to. Ids only.',
  'lib/upload-batches/repository.ts#listInFlightBatchDocuments': 'The upload sweep reconciles in-flight rows, held by definition.',
  'lib/upload-batches/repository.ts#completeSettledBatches': 'Closes batches whose rows all came to rest. No row leaves.',
}

/** Every `.ts` under `src`, specs, fixtures and mocks aside. */
function sourceFiles(dir = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'mocks' || entry.name === 'test-utils') continue
      sourceFiles(full, found)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

const JOIN_METHODS = new Set(['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'])
const RAW_READ = /\b(from|join)\s+("?documents"?\b|\$\{documents\})/i

/** Whether the file imports the `documents` TABLE (a value) from the schema. */
function importsDocumentsTable(tree: ts.SourceFile): boolean {
  return tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('@/lib/db/schema') &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'documents'
      )
  )
}

/** The name of the nearest named function around `node`, or `<module>`. */
function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText()
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      const owner = current.parent
      if (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner)) return owner.name.getText()
    }
  }
  return '<module>'
}

/** Whether `node` is a read of the documents table: a from or join, `db.query.documents`, or raw SQL. */
function isDocumentsRead(node: ts.Node, tableImported: boolean): boolean {
  if (tableImported && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const [first] = node.arguments
    if (JOIN_METHODS.has(node.expression.name.text) && first && ts.isIdentifier(first) && first.text === 'documents') {
      return true
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'documents' && /\.query$/.test(node.expression.getText())) {
    return true
  }
  return ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'sql' && RAW_READ.test(node.template.getText())
}

interface DocumentsRead {
  /** `<path under src>#<function>` */
  key: string
  composes: boolean
}

/** Every read of `documents` in one module, and whether its function composes the predicate. */
function documentsReads(source: string, path: string): DocumentsRead[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const tableImported = importsDocumentsTable(tree)

  // Each named function's body, and the same-module names it calls.
  const bodies = new Map<string, { composes: boolean; calls: Set<string> }>()
  const record = (name: string, body: ts.Node) => {
    const calls = new Set<string>()
    let composes = false
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === PREDICATE) composes = true
        calls.add(node.expression.text)
      }
      ts.forEachChild(node, walk)
    }
    walk(body)
    const known = bodies.get(name)
    bodies.set(name, {
      composes: composes || Boolean(known?.composes),
      calls: new Set([...calls, ...(known?.calls ?? [])]),
    })
  }
  const sites: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body) {
      record(node.name.getText(), node.body)
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      const owner = node.parent
      if (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner)) record(owner.name.getText(), node.body)
    }
    if (isDocumentsRead(node, tableImported)) sites.push(enclosingFunction(node))
    ts.forEachChild(node, visit)
  }
  visit(tree)

  // A function composes when it calls the predicate, or a same-module function that does.
  const composes = (name: string, seen = new Set<string>()): boolean => {
    const body = bodies.get(name)
    if (!body || seen.has(name)) return false
    seen.add(name)
    return body.composes || [...body.calls].some((callee) => composes(callee, seen))
  }
  return [...new Set(sites)].map((name) => ({ key: `${path}#${name}`, composes: composes(name) }))
}

describe('every read of documents states its reader (ADR-0083)', () => {
  const reads = sourceFiles().flatMap((file) =>
    documentsReads(readFileSync(file, 'utf8'), file.slice(SRC.length + 1).replaceAll('\\', '/'))
  )

  it('composes documentVisibleTo, or is listed with the reason it sees every row', () => {
    const offenders = reads.filter((read) => !read.composes && !(read.key in SEES_EVERY_ROW)).map((read) => read.key)
    expect(
      offenders,
      'A query over `documents` that does not compose `documentVisibleTo(reader)`. Take a ' +
        '`DocumentReader` and AND the predicate into its WHERE; only a query that must see ' +
        'held rows (a sweep, a quota sum, an orphan check) belongs in SEES_EVERY_ROW, with why.'
    ).toEqual([])
  })

  it('lists no query that no longer exists, or that now composes the predicate', () => {
    const uncomposed = new Set(reads.filter((read) => !read.composes).map((read) => read.key))
    expect(Object.keys(SEES_EVERY_ROW).filter((key) => !uncomposed.has(key))).toEqual([])
  })

  it('finds the reads it guards (the scan is not vacuous)', () => {
    expect(reads.length).toBeGreaterThan(40)
    expect(reads.map((read) => read.key)).toContain('lib/documents/repository.ts#findDocumentInOrg')
  })

  describe('the guard itself', () => {
    const header = "import { documents } from '@/lib/db/schema'\nimport { sql } from 'drizzle-orm'\n"
    const check = (body: string) => documentsReads(header + body, 'probe.ts')

    it.each([
      ['a select', 'export function f() { return db.select().from(documents) }'],
      ['an inner join', 'export function f() { return db.select().from(bimModels).innerJoin(documents, on) }'],
      ['a left join', 'export const f = () => db.select().from(x).leftJoin(documents, on)'],
      ['raw SQL', 'export function f() { return sql`SELECT 1 FROM documents d WHERE d.id = ${id}` }'],
      ['raw SQL with the table interpolated', 'export function f() { return sql`SELECT 1 FROM ${documents} WHERE true` }'],
      ['the relational API', 'export function f() { return db.query.documents.findMany() }'],
    ])('flags %s that does not compose the predicate', (_label, body) => {
      expect(check(body)).toEqual([{ key: 'probe.ts#f', composes: false }])
    })

    it('accepts a query that composes the predicate', () => {
      expect(check('export function f(r) { return db.select().from(documents).where(documentVisibleTo(r)) }')).toEqual([
        { key: 'probe.ts#f', composes: true },
      ])
    })

    it('accepts a query whose same-module helper composes it, transitively', () => {
      const body =
        'function inner(r) { return and(x, documentVisibleTo(r)) }\n' +
        'function where(r) { return inner(r) }\n' +
        'export function f(r) { return db.select().from(documents).where(where(r)) }'
      expect(check(body)).toEqual([{ key: 'probe.ts#f', composes: true }])
    })

    it('does not flag an update, a delete, or another table', () => {
      const body =
        'export function f() { db.update(documents).set({}); db.delete(documents); return db.select().from(projects) }'
      expect(check(body)).toEqual([])
    })

    it('does not take a local array called documents for the table', () => {
      const source = 'export function f(documents) { return documents.from(documents) }'
      expect(documentsReads(source, 'probe.ts')).toEqual([])
    })
  })
})
