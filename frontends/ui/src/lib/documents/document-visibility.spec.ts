/**
 * The hold is a reader every query states, not a status every reader remembers
 * (ADR-0086, amended 2026-10-08).
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
  'lib/storage/repository.ts#aggregateStorageUsage': 'Quota: a held file occupies storage like any other (ADR-0086, Consequences).',
  'lib/storage/repository.ts#aggregateStorageUsageByOrganization': 'Quota, per organization, for the platform view: every byte.',
  'lib/storage/repository.ts#readStorageUsage': 'Quota admission under the lock: every byte, or a held upload is free storage.',
  'lib/storage/repository.ts#sumItemBytes': 'Quota: item bytes, every row.',
  'lib/storage/repository.ts#versionOverheadByScope': 'Quota: version bytes, every row.',
  'lib/storage/repository.ts#versionOverheadBytes': 'Quota: version bytes, every row.',
  'lib/storage/repository.ts#versionOverheadSql': 'Quota: the version-overhead fragment the sums above share.',

  // --- Placement and the Papierkorb move every document of a folder ---------
  'lib/documents/placement-repository.ts#listPlacementRows':
    "Placement moves every document whose folder's access changed into the right collection, held ones too, or a held file stays in a collection readers it should not have can search once it passes.",
  'lib/documents/placement-repository.ts#takeAwaitingPlacementReingest':
    'The `placement_reingest` job takes the rows placement marked for their re-read. Rows to a job, nothing to a person; a quarantined row is never marked.',
  'lib/projects/folder-bin-repository.ts#listDocumentIdsInFolders': 'The Papierkorb moves a folder with every document in it.',
  'lib/projects/folder-bin-repository.ts#listDocumentPageInFolders':
    'The Papierkorb purges, takes out of retrieval and restores every document of a folder, in pages for its jobs.',
  'lib/projects/folder-bin-repository.ts#listRestoringDocumentPage':
    'The `restore_folder_bin` job re-dispatches the rows its restore stamped; a quarantined row is never stamped. Rows to a job.',
  'lib/projects/folder-derived-repository.ts#listReportsDerivedFrom':
    "Piloti's own reports drawn from a purged folder: the purge marks every one of them, and none of them is an upload.",
  'lib/authz/folder-access-repository.ts#listProjectDocumentCollections':
    'Which retrieval collections a project uses, for folder access decisions. Collection names, never a document.',
  'lib/authz/folder-access-repository.ts#countIfcDocumentsInFolders':
    'Refuses restricting a folder that holds an IFC model, held or not: the guard is about the building data, which exists either way.',

  // --- Judging a revision task by where its document is now (ADR-0092) -------
  'lib/tasks/repository.ts#findSubjectDocumentPlaces':
    "A revision task's document's project and folder, never its content: the folder decides who may see the TASK, and a held document's folder decides it as well as a screened one's.",
  'lib/conversations/restricted-use-repository.ts#listRevisionSubjectFolders':
    "The current folder of the document a revision task in this thread revises, to judge who may read the THREAD; only the folder id leaves the query, and a held document's folder restricts as well as a screened one's.",

  // --- The upload machinery's own bookkeeping --------------------------------
  'lib/upload-batches/repository.ts#batchIdsOfDocuments': 'The settle hook: which batches the rows a reconcile moved belong to. Ids only.',
  'lib/upload-batches/repository.ts#listInFlightBatchDocuments': 'The upload sweep reconciles in-flight rows, held by definition.',
  'lib/upload-batches/repository.ts#completeSettledBatches': 'Closes batches whose rows all came to rest. No row leaves.',
}

/**
 * Reads of a table that carries one document's facts which do not join
 * `documents` themselves, keyed `<path under src>#<function>|<table>`. Each is
 * keyed by a document or model id that a reader's rule already let through,
 * and says which read that was.
 */
const KEYED_BY_A_READ_DOCUMENT: Record<string, string> = {
  // --- Versions: keyed by a document the caller already read ----------------
  'lib/documents/version-repository.ts#listDocumentVersions|documentVersions':
    'The version list and the last refusers, after `getAccessibleDocument` / `findDocumentForSession` read the document.',
  'lib/documents/version-repository.ts#findDocumentVersion|documentVersions':
    'A version of a document the transition, the view or the content read loaded through its reader first.',
  'lib/documents/version-repository.ts#findPreviousVersion|documentVersions':
    "The version before the one a transition just moved, of the document that transition read.",
  'lib/documents/version-repository.ts#findDocumentVersionInOrg|documentVersions':
    "`readVersionForService` reads the version's document through SCREENED_ONLY before it returns a byte.",
  'lib/documents/version-repository.ts#findPublishedVersion|documentVersions': 'The fork, after `getAccessibleDocument(…, "write")`.',
  'lib/documents/version-repository.ts#findOpenVersion|documentVersions':
    'The fork, the status read and the filing paths, each after reading the document (or writing it a moment ago).',
  'lib/documents/version-repository.ts#listDocumentVersionSummaries|documentVersions':
    'Annotates rows a listing already narrowed by its reader; ids in, never a project id.',
  'lib/documents/version-repository.ts#listDocumentVersionObjects|documentVersions':
    "Erasing a document's objects, after the delete authorized the document.",
  'lib/documents/version-repository.ts#nextVersionNumber|documentVersions': 'The key of an upload that is replacing this document. A number, no fact.',
  'lib/documents/version-repository.ts#allocateVersionNumber|documentVersions': 'Inside the insert of a new version. A number, no fact.',
  'lib/projects/folder-derived-repository.ts#listReportsDerivedFrom|documentVersions':
    "Piloti's own reports drawn from a purged folder (see SEES_EVERY_ROW): none of them is an upload.",
  'lib/storage/repository.ts#versionOverheadByScope|documentVersions': 'Quota: version bytes, every row.',
  'lib/storage/repository.ts#versionOverheadBytes|documentVersions': 'Quota: version bytes, every row.',

  // --- IFC models and elements: keyed by a model already read ---------------
  'lib/bim/repository.ts#elementScope|bimModels':
    "The tenant half of every element query's WHERE, on a model id `getAccessibleModel` or `runBimQuery` already read.",
  'lib/bim/repository.ts#listBimElements|bimElements': 'Elements of a model read through its reader (`getAccessibleModel`, `resolveInternalModel`).',
  'lib/bim/repository.ts#findBimElement|bimElements': 'One element of a model read through its reader.',
  'lib/bim/repository.ts#findBimElementsByGlobalIds|bimElements': 'Elements of a model read through its reader.',
  'lib/bim/repository.ts#aggregateBimElements|bimElements': 'Counts over a model read through its reader.',
  'lib/bim/repository.ts#listBimPropertyCatalog|bimModels': 'The tenant check of a model read through its reader.',
  'lib/bim/repository.ts#listBimPropertyCatalog|bimElements': 'Property names of a model read through its reader.',
  'lib/bim/repository.ts#loadBimElementsForComparison|bimElements': 'Two revisions, each read through its reader first.',
  'lib/bim/repository.ts#loadBimRuleInputs|bimModels': 'The rule projection of a model read through its reader.',
  'lib/bim/repository.ts#loadBimElementsForSchedule|bimElements': 'Elements of a model read through its reader.',
  'lib/bim/repository.ts#countBimElementsByType|bimElements': 'Counts over a model read through its reader.',

  // --- Assignments: keyed by resources already authorized ------------------
  'lib/assignments/repository.ts#listAssignmentsForResources|resourceAssignments':
    'Ids from `requireResourceAccess` (which reads a document through the sharing registry) or from a listing its reader narrowed.',
}

/**
 * Where a reader that sees held rows is made, keyed `<path under src>#<function>`.
 * `makes` is what it makes: `internal:<why>`, `reviewer`.
 */
const ELEVATED_READERS: Record<string, { makes: string[]; why: string }> = {
  'lib/upload-screening/quarantine-reviewers.ts#shelfReaderFor': {
    makes: ['reviewer'],
    why: 'The one place a person becomes a reviewer of a shelf: after `mayReviewQuarantine` said so.',
  },
  'lib/documents/access.ts#findDocumentForSession': {
    makes: ['internal:quarantine-review'],
    why: 'Loads a row the member rule refused, to ask `mayReviewQuarantine`; returns it only on yes.',
  },
  'lib/upload-screening/review.ts#releaseQuarantinedDocument': {
    makes: ['internal:quarantine-review'],
    why: 'Loads the row to ask `mayReviewQuarantine`; a non-reviewer gets 404.',
  },
  'lib/upload-batches/settle.ts#onQuarantined': {
    makes: ['internal:audit'],
    why: "The reviewers' notification about a verdict the reconcile just wrote.",
  },
  'lib/bim/model-service.ts#getAccessibleModel': {
    makes: ['internal:resolve-document'],
    why: "Learns WHICH document a model id belongs to; `findDocumentForSession` then decides on that document.",
  },
  'lib/bim/model-service.ts#getModelForDocument': {
    makes: ['internal:reloaded'],
    why: 'The model of a document this request just loaded through `findDocumentForSession`.',
  },
  'lib/bim/query.ts#runBimQuery': {
    makes: ['internal:reloaded'],
    why: 'Models (and a comparison base) whose caller resolved them through a reader a moment ago.',
  },
  'lib/document-roles/repository.ts#findBindingsForRole': {
    makes: ['internal:identity'],
    why: "Whether a role is taken, which the unique index answers over every row; returns no held document's facts.",
  },
  'lib/conversations/restricted-egress.ts#requirePlanDocumentsOpen': {
    makes: ['internal:identity'],
    why: "Whether a run's Unterlagen name a file in a restricted folder: every row by that name, held ones included, and only ever a refusal.",
  },
  'lib/documents/repository.ts#findDocumentAuthoredByRef': {
    makes: ['internal:identity'],
    why: "Idempotency of Piloti's filing by its run reference, which a unique index answers over every row.",
  },
  'lib/documents/repository.ts#findLiveDocumentByFilename': {
    makes: ['internal:identity'],
    why: 'The name probe of an upload; a held row of another person answers as taken (`assertMayReplaceHeld`).',
  },
  'lib/documents/repository.ts#findProjectCollectionsHoldingFilename': {
    makes: ['internal:identity'],
    why: 'Which collections already hold a filename: identity, over every row.',
  },
  'lib/documents/repository.ts#findStorageKeyByIdAndCollection': {
    makes: ['internal:ingest'],
    why: 'The pipeline presigns a raster slot for the file it is reading (service token, no person).',
  },
  'lib/documents/repository.ts#documentExistsInCollection': {
    makes: ['internal:ingest'],
    why: 'The pipeline asks whether the file it just indexed still exists (service token, no person).',
  },
  'lib/documents/service.ts#dispatchIngest': { makes: ['internal:ingest'], why: "The dispatch reads the row it sends: whose spend, which rules." },
  'lib/documents/service.ts#dispatchDocument': { makes: ['internal:ingest'], why: 'The one funnel every ingest passes reads its row.' },
  'lib/documents/service.ts#jobStillOwnsRow': { makes: ['internal:ingest'], why: 'A background job asks whether the row is still its own.' },
  'lib/documents/service.ts#redispatchStuckDocument': { makes: ['internal:ingest'], why: 'The sweep re-dispatches a stuck row.' },
  'lib/documents/service.ts#runReindexSlice': {
    makes: ['internal:ingest'],
    why: 'A reindex re-dispatches every row of the project; `dispatchDocument` leaves a quarantine where it is.',
  },
  'lib/documents/lifecycle.ts#recordUploadedVersion': {
    makes: ['internal:just-written'],
    why: 'Reads back the row the upload wrote a moment ago, to record its version.',
  },
  'lib/documents/agent-document.ts#fileAgentDocumentDraft': {
    makes: ['internal:just-written'],
    why: "Reads back Piloti's own document it just filed.",
  },
  'lib/documents/research-report.ts#openReviewRound': {
    makes: ['internal:just-written'],
    why: "Reads back Piloti's report it just filed, to open its review.",
  },
  'lib/tasks/service.ts#fileResultFor': {
    makes: ['internal:just-written'],
    why: "Reads back the task result it just filed as Piloti's document.",
  },
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

/** The `documents` table, and the tables whose rows carry one document's facts, by schema export and SQL name. */
const GUARDED_TABLES: Record<string, string> = {
  documents: 'documents',
  documentVersions: 'document_versions',
  documentRoles: 'document_roles',
  bimModels: 'bim_models',
  bimElements: 'bim_elements',
  bimCheckConfirmations: 'bim_check_confirmations',
  resourceAssignments: 'resource_assignments',
}

/** The relational-API names that reach `documents` from another table (`one(documents)`, `many(documents)`). */
function documentRelations(): Set<string> {
  const names = new Set<string>()
  const dir = join(SRC, 'lib/db/schema')
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue
    const tree = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        ['one', 'many'].includes(node.initializer.expression.text) &&
        node.initializer.arguments[0]?.getText() === 'documents'
      ) {
        names.add(node.name.getText())
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return names
}
const DOCUMENT_RELATIONS = documentRelations()

const JOIN_METHODS = new Set(['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'])

/** `FROM documents`, `JOIN "public"."bim_models"`, `FROM ${documents}`: raw SQL that reads a guarded table. */
function rawReadOf(text: string, interpolated: ReadonlySet<string>): string | null {
  for (const [exported, sqlName] of Object.entries(GUARDED_TABLES)) {
    const name = new RegExp(`\\b(from|join)\\s+(("?public"?\\.)?"?${sqlName}"?\\b)`, 'i')
    if (name.test(text)) return exported
  }
  const slot = /\b(from|join)\s+\$\{\s*([\w.]+)\s*\}/gi
  for (const match of text.matchAll(slot)) {
    const local = match[2].split('.').pop() ?? ''
    if (interpolated.has(match[2]) || local in GUARDED_TABLES) {
      return interpolated.has(match[2]) ? 'documents' : local
    }
  }
  return null
}

/** How this module names the guarded tables: imported (perhaps renamed), or through a namespace import of the schema. */
interface Bindings {
  tables: Map<string, string>
  namespaces: Set<string>
}

function schemaBindings(tree: ts.SourceFile): Bindings {
  const tables = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.startsWith('@/lib/db/schema')) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text)
      continue
    }
    for (const element of clause.namedBindings.elements) {
      const exported = (element.propertyName ?? element.name).text
      if (!element.isTypeOnly && exported in GUARDED_TABLES) tables.set(element.name.text, exported)
    }
  }
  return { tables, namespaces }
}

/** The guarded table an expression names in this module, or null. */
function tableOf(expression: ts.Expression | undefined, bindings: Bindings): string | null {
  if (!expression) return null
  if (ts.isIdentifier(expression)) return bindings.tables.get(expression.text) ?? null
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    expression.name.text in GUARDED_TABLES
  ) {
    return expression.name.text
  }
  return null
}

/** The guarded table `node` reads, or null: a from or join, the relational API, an include, or raw SQL. */
function readOf(node: ts.Node, bindings: Bindings): string | null {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (JOIN_METHODS.has(node.expression.name.text)) {
      const table = tableOf(node.arguments[0], bindings)
      if (table) return table
    }
    // `sql.raw('SELECT … FROM documents')`: not a tagged template, read the same.
    if (node.expression.getText() === 'sql.raw' && node.arguments[0]) {
      const table = rawReadOf(node.arguments[0].getText(), new Set())
      if (table) return table
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text in GUARDED_TABLES && /\.query$/.test(node.expression.getText())) {
    return node.name.text
  }
  // `db.query.bimModels.findMany({ with: { document: true } })`: the include reads `documents`.
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === 'with' &&
    ts.isObjectLiteralExpression(node.initializer) &&
    node.initializer.properties.some((property) => property.name && DOCUMENT_RELATIONS.has(property.name.getText()))
  ) {
    return 'documents'
  }
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'sql') {
    return rawReadOf(node.template.getText(), new Set([...bindings.tables.keys()].filter((name) => bindings.tables.get(name) === 'documents')))
  }
  return null
}

/** The name of the nearest named function around `node`, or `<module>`. */
function enclosingFunction(node: ts.Node): string {
  const fn = enclosingFunctionNode(node)
  return fn ? functionName(fn) : '<module>'
}

type FunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

function functionName(fn: FunctionNode): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText()
  const owner = fn.parent
  if (owner && (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner))) return owner.name.getText()
  return '<anonymous>'
}

/** The nearest NAMED function around `node`: an unnamed callback belongs to the function it is written in. */
function enclosingFunctionNode(node: ts.Node): FunctionNode | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      functionName(current) !== '<anonymous>'
    ) {
      return current
    }
  }
  return null
}

/**
 * The whole query a read site belongs to: the method chain around a `from` or a
 * join (`db.select().from(documents).innerJoin(…).where(…)`), the relational
 * call around an include, the template itself for raw SQL. A predicate
 * elsewhere in the same function guards some other query, not this one.
 */
function queryOf(site: ts.Node): ts.Node {
  let node: ts.Node = site
  if (ts.isPropertyAssignment(site)) {
    for (let current: ts.Node | undefined = site.parent; current; current = current.parent) {
      if (ts.isCallExpression(current)) {
        node = current
        break
      }
    }
  }
  if (ts.isTaggedTemplateExpression(site)) return site
  for (;;) {
    const parent: ts.Node | undefined = node.parent
    if (!parent) return node
    const chained =
      (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
      (ts.isCallExpression(parent) && parent.expression === node) ||
      ts.isNonNullExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    if (!chained) return node
    node = parent
  }
}

interface DocumentsRead {
  /** `<path under src>#<function>` */
  key: string
  /** The guarded table the query reads. */
  table: string
  composes: boolean
}

/** Every read of a guarded table in one module, and whether THAT query composes the predicate. */
function documentsReads(source: string, path: string): DocumentsRead[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const bindings = schemaBindings(tree)

  // Same-module functions and module constants, by name, for the transitive check.
  const definitions = new Map<string, ts.Node[]>()
  const define = (name: string, body: ts.Node) => definitions.set(name, [...(definitions.get(name) ?? []), body])
  const sites: ts.Node[] = []
  const tables = new Map<ts.Node, string>()
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body) {
      define(node.name.getText(), node.body)
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      define(node.name.text, node.initializer)
    }
    const table = readOf(node, bindings)
    if (table) {
      sites.push(node)
      tables.set(node, table)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)

  // Whether `expression` composes the predicate: calls it, calls a same-module
  // function that does, or names a binding (a local `where`, a module constant)
  // whose definition does.
  const composesIn = (expression: ts.Node, seen: Set<string>): boolean => {
    let found = false
    const walk = (node: ts.Node) => {
      if (found) return
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PREDICATE) {
        found = true
        return
      }
      if (ts.isIdentifier(node) && !seen.has(node.text) && definitions.has(node.text)) {
        seen.add(node.text)
        if (definitions.get(node.text)!.some((definition) => composesIn(definition, seen))) {
          found = true
          return
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(expression)
    return found
  }

  // A query held in a variable and narrowed later (`const q = db.select().from(documents)…; q.where(…)`)
  // composes where the variable is used.
  const usesOfHeldQuery = (query: ts.Node): ts.Node[] => {
    const holder = query.parent
    if (!holder || !ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) return []
    const fn = enclosingFunctionNode(query)
    const name = holder.name.text
    const uses: ts.Node[] = []
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name && node !== holder.name) uses.push(queryOf(node))
      ts.forEachChild(node, walk)
    }
    if (fn?.body) walk(fn.body)
    return uses
  }

  const byKey = new Map<string, DocumentsRead>()
  for (const site of sites) {
    const query = queryOf(site)
    const composes = [query, ...usesOfHeldQuery(query)].some((part) => composesIn(part, new Set()))
    const key = `${path}#${enclosingFunction(site)}`
    const table = tables.get(site)!
    const known = byKey.get(`${key}|${table}`)
    // A function is as good as its weakest query over the table.
    byKey.set(`${key}|${table}`, { key, table, composes: composes && (known?.composes ?? true) })
  }
  return [...byKey.values()]
}

/**
 * Where a reader that sees held rows is made: `internalRead(why)`, the
 * reviewer's reader, or the object literal either stands for. Keyed
 * `<path under src>#<function>`, valued by what it makes (`internal:<why>` or
 * `reviewer`).
 */
function elevatedReaders(source: string, path: string): Array<{ key: string; makes: string }> {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ key: string; makes: string }> = []
  const visit = (node: ts.Node) => {
    const at = () => `${path}#${enclosingFunction(node)}`
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'internalRead') {
      const [why] = node.arguments
      found.push({ key: at(), makes: why && ts.isStringLiteral(why) ? `internal:${why.text}` : 'internal:<not a literal>' })
    }
    if (ts.isIdentifier(node) && node.text === 'REVIEWER_READER' && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent)) {
      found.push({ key: at(), makes: 'reviewer' })
    }
    if (ts.isObjectLiteralExpression(node)) {
      const kind = node.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText() === 'kind' && ts.isStringLiteral(property.initializer)
      )
      const literal = kind && (kind.initializer as ts.StringLiteral).text
      if (literal === 'internal' || literal === 'reviewer') found.push({ key: at(), makes: `literal:${literal}` })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

describe('every read of documents states its reader (ADR-0086)', () => {
  const files = sourceFiles().map((file) => ({
    path: file.slice(SRC.length + 1).replaceAll('\\', '/'),
    source: readFileSync(file, 'utf8'),
  }))
  const reads = files.flatMap(({ path, source }) => documentsReads(source, path))
  const documentReads = reads.filter((read) => read.table === 'documents')
  const factReads = reads.filter((read) => read.table !== 'documents')

  it('composes documentVisibleTo, or is listed with the reason it sees every row', () => {
    const offenders = documentReads.filter((read) => !read.composes && !(read.key in SEES_EVERY_ROW)).map((read) => read.key)
    expect(
      offenders,
      'A query over `documents` that does not compose `documentVisibleTo(reader)`. Take a ' +
        '`DocumentReader` and AND the predicate into THAT query\'s WHERE; only a query that must see ' +
        'held rows (a sweep, a quota sum, an orphan check) belongs in SEES_EVERY_ROW, with why.'
    ).toEqual([])
  })

  it("reads a document's facts from another table only behind the predicate, or keyed by a document already read", () => {
    const offenders = factReads
      .filter((read) => !read.composes && !(`${read.key}|${read.table}` in KEYED_BY_A_READ_DOCUMENT))
      .map((read) => `${read.key}|${read.table}`)
    expect(
      offenders,
      'A query over a table that carries a document\'s facts (versions, roles, IFC models and ' +
        'elements, check confirmations, assignments) that neither joins `documents` behind ' +
        '`documentVisibleTo(reader)` nor is listed in KEYED_BY_A_READ_DOCUMENT with the read ' +
        'that authorized the document it is keyed by.'
    ).toEqual([])
  })

  it('lists no query that no longer exists, or that now composes the predicate', () => {
    const uncomposed = new Set(reads.filter((read) => !read.composes).map((read) => read.key))
    const uncomposedFacts = new Set(factReads.filter((read) => !read.composes).map((read) => `${read.key}|${read.table}`))
    expect(Object.keys(SEES_EVERY_ROW).filter((key) => !uncomposed.has(key))).toEqual([])
    expect(Object.keys(KEYED_BY_A_READ_DOCUMENT).filter((key) => !uncomposedFacts.has(key))).toEqual([])
  })

  it('makes a reader that sees held rows only where ELEVATED_READERS says why', () => {
    const made = new Map<string, Set<string>>()
    for (const { path, source } of files) {
      if (path === 'lib/documents/document-reader.ts') continue
      for (const { key, makes } of elevatedReaders(source, path)) made.set(key, new Set([...(made.get(key) ?? []), makes]))
    }
    const actual = Object.fromEntries([...made].map(([key, kinds]) => [key, [...kinds].sort().join(',')]).sort())
    const expected = Object.fromEntries(
      Object.entries(ELEVATED_READERS).map(([key, entry]) => [key, [...entry.makes].sort().join(',')]).sort()
    )
    expect(
      actual,
      'A reader that sees held rows (`internalRead(why)`, `REVIEWER_READER`, or the object ' +
        'literal for either) made where ELEVATED_READERS does not list it, or with another ' +
        'reason. A person-facing path takes its reader from `shelfReaderFor` or `memberReader`.'
    ).toEqual(expected)
  })

  it('finds the reads it guards (the scan is not vacuous)', () => {
    expect(documentReads.length).toBeGreaterThan(40)
    expect(documentReads.map((read) => read.key)).toContain('lib/documents/repository.ts#findDocumentInOrg')
    expect(factReads.map((read) => read.table)).toEqual(
      expect.arrayContaining(['documentVersions', 'bimModels', 'bimElements', 'bimCheckConfirmations', 'resourceAssignments'])
    )
    expect(DOCUMENT_RELATIONS).toEqual(new Set(['documents', 'document']))
  })

  describe('the guard itself', () => {
    const header = "import { documents, bimModels } from '@/lib/db/schema'\nimport { sql } from 'drizzle-orm'\n"
    const check = (body: string, prelude = header) =>
      documentsReads(prelude + body, 'probe.ts').filter((read) => read.table === 'documents')

    it.each([
      ['a select', 'export function f() { return db.select().from(documents) }'],
      ['an inner join', 'export function f() { return db.select().from(bimModels).innerJoin(documents, on) }'],
      ['a left join', 'export const f = () => db.select().from(x).leftJoin(documents, on)'],
      ['raw SQL', 'export function f() { return sql`SELECT 1 FROM documents d WHERE d.id = ${id}` }'],
      ['raw SQL on the schema-qualified name', 'export function f() { return sql`SELECT 1 FROM public.documents d` }'],
      ['raw SQL quoted and qualified', 'export function f() { return sql`SELECT 1 FROM "public"."documents" d` }'],
      ['raw SQL with the table interpolated', 'export function f() { return sql`SELECT 1 FROM ${documents} WHERE true` }'],
      ['sql.raw, which is not a tagged template', "export function f() { return db.execute(sql.raw('SELECT id FROM documents')) }"],
      ['the relational API', 'export function f() { return db.query.documents.findMany() }'],
      ['an include from another table', 'export function f() { return db.query.bimModels.findMany({ with: { document: true } }) }'],
    ])('flags %s that does not compose the predicate', (_label, body) => {
      expect(check(body)).toEqual([{ key: 'probe.ts#f', table: 'documents', composes: false }])
    })

    it('flags the table imported under another name, or through the schema namespace', () => {
      const aliased = "import { documents as docs } from '@/lib/db/schema'\n"
      expect(check('export function f() { return db.select().from(docs) }', aliased)).toEqual([
        { key: 'probe.ts#f', table: 'documents', composes: false },
      ])
      const namespace = "import * as schema from '@/lib/db/schema'\n"
      expect(check('export function f() { return db.select().from(schema.documents) }', namespace)).toEqual([
        { key: 'probe.ts#f', table: 'documents', composes: false },
      ])
    })

    it('asks each query, not its function: a predicate on one query does not cover the next', () => {
      const body =
        'export async function f(r) {\n' +
        '  const mine = await db.select().from(documents).where(documentVisibleTo(r))\n' +
        '  const all = await db.select().from(documents)\n' +
        '  return [mine, all]\n' +
        '}'
      expect(check(body)).toEqual([{ key: 'probe.ts#f', table: 'documents', composes: false }])
    })

    it('accepts a query that composes the predicate', () => {
      expect(check('export function f(r) { return db.select().from(documents).where(documentVisibleTo(r)) }')).toEqual([
        { key: 'probe.ts#f', table: 'documents', composes: true },
      ])
    })

    it('accepts a predicate held in a local, or in a same-module helper, transitively', () => {
      const local = 'export function f(r) { const where = and(x, documentVisibleTo(r)); return db.select().from(documents).where(where) }'
      expect(check(local)).toEqual([{ key: 'probe.ts#f', table: 'documents', composes: true }])
      const helper =
        'function inner(r) { return and(x, documentVisibleTo(r)) }\n' +
        'function where(r) { return inner(r) }\n' +
        'export function f(r) { return db.select().from(documents).where(where(r)) }'
      expect(check(helper)).toEqual([{ key: 'probe.ts#f', table: 'documents', composes: true }])
    })

    it('accepts a query held in a variable and narrowed where it is used', () => {
      const body =
        'export function f(r) { const q = db.select().from(documents).$dynamic(); return q.where(documentVisibleTo(r)) }'
      expect(check(body)).toEqual([{ key: 'probe.ts#f', table: 'documents', composes: true }])
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

    it('finds a reader that sees held rows wherever it is made', () => {
      const source =
        "export function f() { return list(internalRead('identity')) }\n" +
        'export function g() { return list(REVIEWER_READER) }\n' +
        "export function h() { return list({ kind: 'internal', why: 'audit' }) }"
      expect(elevatedReaders(source, 'probe.ts')).toEqual([
        { key: 'probe.ts#f', makes: 'internal:identity' },
        { key: 'probe.ts#g', makes: 'reviewer' },
        { key: 'probe.ts#h', makes: 'literal:internal' },
      ])
    })
  })
})
