/**
 * @vitest-environment node
 */

/**
 * The guard that makes the status vocabulary knowable.
 *
 * `documents.status` is an open `text` column with no CHECK, so nothing has
 * ever failed when a writer invented a value: the badge fell back to a neutral
 * chip, the poller's in-flight set silently disagreed with the badge's table by
 * two members, and migration 0063 added a twelfth value to a set nobody owned.
 * That is the "correlated substrate debt" failure `AGENTS.md` names — a shared
 * vocabulary with no owner and no test.
 *
 * This spec is the owner. It reads the WRITERS' own source and fails when one
 * of them emits a status that `document-status.ts` never declared, so the next
 * value costs one entry there instead of a grey badge nobody notices.
 *
 * ## What this guard can see, and what it cannot
 *
 * Stated exactly, because the first version of it read as complete and was not.
 * It matched ONE shape — `status: 'lower_snake'` in single quotes — and eight
 * realistic drifts walked past it: a hyphenated value (`'not-indexed'`, a
 * natural name for exactly this feature), a digit, a capital, double quotes, a
 * raw `sql\`UPDATE … SET status = 'purged'\``, a plain assignment
 * `row.status = 'redacted'`, a value read from a variable, and a template
 * literal. A guard that misses eight of nine is worse than no guard, because
 * its green is read as coverage.
 *
 * So the scan is now an AST walk (`typescript`, the same tool
 * `server-component-db-access.spec.ts` uses) rather than one regex, and it
 * reports in two parts:
 *
 *   1. **Literal writes** — a status written as a string, in ANY quote style,
 *      with any characters, as a property (`{ status: 'x' }`), as an assignment
 *      (`row.status = 'x'`), inside a `sql` template (`SET status = 'x'`), or
 *      declared as a union in a type (`status: 'x' | 'y'`, a service promising
 *      what it may return). Every one of them must be declared.
 *   2. **OPAQUE writes** — a status handed a variable, a property, a call or an
 *      interpolated template. No scanner can read those, and the honest answer
 *      is not to pretend: they are enumerated against {@link OPAQUE_STATUS_WRITES}
 *      with what each one can actually write, so a NEW one fails and has to be
 *      explained rather than joining the invisible majority.
 *
 * The real example is `setDocumentReconciledStatus`, which writes
 * `resolution.status` straight from the reconciler. Nothing about that call site
 * says what lands in the column; the only reason `completed` and `failed` are
 * known at all is that `reconcile-status.ts` — which is scanned — spells them
 * out. Move that decision behind one more hop and this guard goes blind, and
 * that is a property of scanning, not a bug to be fixed here.
 *
 * What it deliberately does NOT assert: that the writers agree with each other.
 * They do not — `reconcile-status.ts` writes `completed`/`failed` while the
 * column's documentation says `processed`/`error` — and unifying them is a
 * migration over live rows, not this change.
 *
 * It also does not read the Python side. `documents.status` is written from
 * this repository; a value arriving over HTTP from the backend is somebody
 * else's vocabulary, which is why comparisons are excluded below.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { getByPath } from '@/i18n/translate'
import {
  DOCUMENT_STATUS_FACTS,
  IN_FLIGHT_DOCUMENT_STATUSES,
  KNOWN_DOCUMENT_STATUSES,
  documentStatusFacts,
  isKnownDocumentStatus,
} from './document-status'

/**
 * The modules that WRITE `documents.status` — the documents domain and the two
 * shelves that upload through their own services (Archiv, session documents).
 * Directories rather than a file list on purpose: a new writer in one of them
 * is caught the day it lands, which is the whole point of scanning at all.
 */
const WRITER_DIRS = ['src/lib/documents', 'src/lib/session-documents', 'src/lib/archiv']

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, found)
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) found.push(path)
  }
  return found
}

/** A status value the scan could read, and where. */
interface LiteralWrite {
  value: string
  where: string
}

/**
 * A status the scan could NOT read: the column is handed an expression.
 *
 * Recorded rather than ignored, because "the scanner saw nothing here" and
 * "nothing is written here" are different facts and the old guard reported them
 * identically.
 */
interface OpaqueWrite {
  expression: string
  where: string
}

/**
 * The writes this guard cannot read, and what each one can actually put in the
 * column.
 *
 * Every entry is a hole in the scan, named. They are here rather than silently
 * skipped for the same reason `server-component-db-access.spec.ts` lists its
 * pre-existing route handlers: the number is visible, a new one is a question in
 * review, and anything not on the list fails immediately.
 *
 * Keyed by `<file>: <expression>` rather than by line, so moving code does not
 * churn the list while CHANGING what a site writes does.
 */
const OPAQUE_STATUS_WRITES: Readonly<Record<string, string>> = {
  // The one genuinely load-bearing hole. The reconciler decides the value and
  // the repository writes it verbatim, so this call site says nothing about
  // what lands in the column — `completed` and `failed` are known only because
  // `reconcile-status.ts` spells them out, and it is scanned. A decision moved
  // one hop further away would be invisible here.
  'src/lib/documents/repository.ts: resolution.status':
    "whatever reconcile-status.ts resolved: 'completed' or 'failed'",
  // Reads, not writes: a drizzle SELECT projection naming the column.
  'src/lib/documents/repository.ts: documents.status': 'a SELECT projection, not a write',
  'src/lib/session-documents/repository.ts: documents.status': 'a SELECT projection, not a write',
  'src/lib/archiv/repository.ts: documents.status': 'a SELECT projection, not a write',
  // The reconciler's own plumbing: an HTTP status, a backend file state, and
  // its resolution being handed on. None of them reaches the column except
  // through the repository entry above.
  'src/lib/documents/reconcile-status.ts: response.status': 'an HTTP status code, not the column',
  'src/lib/documents/reconcile-status.ts: file.status':
    "the BACKEND's file state, compared against, never stored",
  'src/lib/documents/reconcile-status.ts: resolution.status':
    'the value this module just decided, on its way to the repository',
  // Service return values: what the CALLER is told, not what the row holds.
  'src/lib/documents/service.ts: ingestStatus': "the dispatcher's job status, returned to the caller",
  'src/lib/documents/service.ts: doc.status': 'the row being read back, returned to the caller',
  'src/lib/documents/service.ts: reconciled.status': 'a reconciled status, returned to the caller',
  // Shorthand `{ status }` in a service's RETURN value — the dispatcher's job
  // status on its way back to the caller. Shorthand is worth listing separately
  // from the rest: the name is all there is, so even the expression a reader
  // could follow by eye is gone.
  'src/lib/documents/service.ts: status': "the dispatcher's job status, returned to the caller",
  'src/lib/session-documents/service.ts: status':
    "the dispatcher's job status, returned to the caller",
  'src/lib/archiv/service.ts: status': "the dispatcher's job status, returned to the caller",
}

/** `status` as a property name, in either spelling an object literal allows. */
function isStatusName(name: ts.Node): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'status'
}

/**
 * The string values an expression can be, or `null` when it cannot be read.
 *
 * Follows the shapes a status is actually written in — a conditional, a `??`
 * default, an `as const` — because each of them is a real write with a readable
 * value, and treating them as opaque would put ordinary code on the list above.
 * A number is neither: `documents.status` is a text column, so `{ status: 404 }`
 * is an HTTP response and not a drift.
 */
function literalValues(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isNumericLiteral(node)) return []
  if (ts.isParenthesizedExpression(node)) return literalValues(node.expression)
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalValues(node.expression)
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalValues(node.whenTrue)
    const whenFalse = literalValues(node.whenFalse)
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const left = literalValues(node.left)
    const right = literalValues(node.right)
    return left && right ? [...left, ...right] : null
  }
  return null
}

/** Every string-literal member of a type annotation, e.g. `'x' | 'y'`. */
function literalTypes(node: ts.TypeNode): string[] {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(literalTypes)
  if (ts.isParenthesizedTypeNode(node)) return literalTypes(node.type)
  return []
}

/**
 * A status written inside a raw SQL template.
 *
 * `sql\`UPDATE documents SET status = 'purged'\`` reaches the column without
 * ever being a TypeScript expression, so the AST walk cannot see the value —
 * only the template's text can. Nothing in the repository writes the column this
 * way today; the scan is here because a hand-written UPDATE is exactly what a
 * migration-adjacent fix reaches for, and it was the drift shape furthest from
 * anything the old regex could match.
 */
const SQL_STATUS_WRITE_RE = /\bstatus"?\s*=\s*(?:'([^']*)'|"([^"]*)")/g

interface Scan {
  literals: LiteralWrite[]
  opaque: OpaqueWrite[]
}

function scanWriters(): Scan {
  const literals: LiteralWrite[] = []
  const opaque: OpaqueWrite[] = []

  for (const dir of WRITER_DIRS) {
    for (const file of sourceFiles(join(process.cwd(), dir))) {
      const source = readFileSync(file, 'utf8')
      const relativePath = relative(process.cwd(), file)
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      const at = (node: ts.Node) => `${relativePath}:${
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
      }`

      const record = (node: ts.Node, value: ts.Expression) => {
        const values = literalValues(value)
        if (values === null) {
          opaque.push({ expression: value.getText(tree), where: at(node) })
          return
        }
        for (const found of values) literals.push({ value: found, where: at(node) })
      }

      const visit = (node: ts.Node): void => {
        // `{ status: 'x' }` — a property assignment only ever exists in an
        // object literal, which is always a value. A type's `status: string`
        // is a PropertySignature and lands in the branch below instead, which
        // is why `string` no longer has to be filtered out by hand.
        if (ts.isPropertyAssignment(node) && isStatusName(node.name)) record(node, node.initializer)
        // `{ status }` — the value is a binding somewhere else entirely.
        else if (ts.isShorthandPropertyAssignment(node) && isStatusName(node.name)) {
          opaque.push({ expression: node.name.text, where: at(node) })
        }
        // `row.status = 'x'` and `status = 'x'`. Comparisons are excluded by
        // demanding a plain `=`: `file.status === 'success'` READS the backend's
        // vocabulary, and pinning that would fail this spec for a change on the
        // other side of an HTTP boundary the column never sees.
        else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'status') ||
            (ts.isIdentifier(node.left) && node.left.text === 'status'))
        ) {
          record(node, node.right)
        }
        // `status: 'x' | 'y'` in a type — a service promising what it may
        // return is a promise about what may end up in the column.
        else if (ts.isPropertySignature(node) && isStatusName(node.name) && node.type) {
          for (const value of literalTypes(node.type)) literals.push({ value, where: at(node) })
        } else if (ts.isTaggedTemplateExpression(node) && node.tag.getText(tree).includes('sql')) {
          for (const match of node.template.getText(tree).matchAll(SQL_STATUS_WRITE_RE)) {
            literals.push({ value: match[1] ?? match[2], where: at(node) })
          }
        }
        ts.forEachChild(node, visit)
      }

      visit(tree)
    }
  }

  return { literals, opaque }
}

describe('every status a writer emits is declared', () => {
  const { literals, opaque } = scanWriters()

  it('finds the writers at all', () => {
    // Half of the assertion below is that the scan found the real vocabulary
    // rather than nothing, which would pass an "everything is declared" check
    // for the wrong reason.
    const found = new Set(literals.map((write) => write.value))
    expect([...found].sort()).toContain('pending')
    expect([...found].sort()).toContain('completed')
    expect([...found].sort()).toContain('stored')
  })

  it('declares every one of them', () => {
    // `isKnownDocumentStatus` is case-insensitive, exactly as the badge's
    // lookup is, so `'Stored'` is declared and `'Purged'` is not — the guard
    // answers the same question the runtime does.
    const undeclared = [...new Set(literals.filter((write) => !isKnownDocumentStatus(write.value)))]
      .map((write) => `${write.value}  (${write.where})`)
      .sort()
    expect(
      undeclared,
      'These statuses are written to documents.status but are not declared in ' +
        'src/lib/documents/document-status.ts, so the badge renders them grey ' +
        'and the poller ignores them. Add an entry with its variant and phase.',
    ).toEqual([])
  })

  it('names every write it could not read', () => {
    // The honest half. A status handed a variable, a property, a call or an
    // interpolated template is unreadable by any scanner, so each one is listed
    // with what it can actually write instead of being silently skipped — which
    // is what the previous version of this guard did with eight drift shapes
    // out of nine.
    const unexplained = [...new Set(opaque.map((write) => `${write.where.split(':')[0]}: ${write.expression}`))]
      .filter((key) => !(key in OPAQUE_STATUS_WRITES))
      .sort()
    expect(
      unexplained,
      'These sites write documents.status from an expression this scan cannot ' +
        'read, so no guard can tell you what value they produce. Either write a ' +
        'literal, or add the site to OPAQUE_STATUS_WRITES saying what it can ' +
        'put in the column.',
    ).toEqual([])
  })

  it('keeps the list of unreadable writes from growing quietly', () => {
    // An entry that no longer matches any site is as misleading as a missing
    // one: it reads as "this hole is understood" for a hole that has moved.
    const present = new Set(opaque.map((write) => `${write.where.split(':')[0]}: ${write.expression}`))
    const stale = Object.keys(OPAQUE_STATUS_WRITES).filter((key) => !present.has(key)).sort()
    expect(stale, 'These OPAQUE_STATUS_WRITES entries match nothing any more.').toEqual([])
  })
})

/**
 * WHERE THE SCAN LOOKS, checked rather than claimed.
 *
 * `WRITER_DIRS` is three directories, and the guard's whole value rests on them
 * being the places a status is authored. Nothing checked that — a writer added
 * anywhere else in `src` was simply invisible, and the suite stayed green.
 *
 * This is the half that can be checked: every module that issues an INSERT or
 * UPDATE against the `documents` table has to be somewhere the scan reads, or
 * be named below as a pass-through that never authors a value.
 */
// NOT global: `RegExp.test` on a `/g` pattern carries `lastIndex` from one call
// to the next, so the second file tested would start scanning from an offset
// the first file happened to end at and could report no match on a real writer.
const TABLE_WRITE_RE = /\.(insert|update)\(\s*documents\s*\)|update\s+"?documents"?\s+set/i

/**
 * Writers of the table that never author a status.
 *
 * `insertDocumentWithinQuota` performs the INSERT for every upload path, but the
 * row arrives as a `NewDocument` its callers built — the value comes from the
 * services the scan already reads. It is here so the exemption is a decision
 * rather than an oversight.
 */
const PASS_THROUGH_TABLE_WRITERS = [
  'src/lib/storage/repository.ts',
  // Re-parents documents when the folder holding them is deleted: it writes
  // `folder_id` and `updated_at` and nothing else. It authors no status and no
  // authorship, so the scan has nothing to find in it — and the day it writes
  // either, this list is what has to be revisited rather than quietly widened.
  'src/lib/projects/folder-service.ts',
]

function everySourceFile(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) everySourceFile(path, found)
    else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) found.push(path)
  }
  return found
}

describe('the scan looks where the writing happens', () => {
  const tableWriters = everySourceFile(join(process.cwd(), 'src'))
    .filter((file) => TABLE_WRITE_RE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(process.cwd(), file))
    .sort()

  it('finds the table writers at all', () => {
    // Same reason as above: an empty list would satisfy the next assertion
    // while proving nothing.
    expect(tableWriters).toContain('src/lib/documents/repository.ts')
  })

  it('has no writer of the documents table outside the scanned directories', () => {
    const unscanned = tableWriters.filter(
      (file) =>
        !WRITER_DIRS.some((dir) => file.startsWith(`${dir}/`)) &&
        !PASS_THROUGH_TABLE_WRITERS.includes(file),
    )
    expect(
      unscanned,
      'These modules write the documents table but sit outside WRITER_DIRS, so ' +
        'any status they author is invisible to this guard. Add the directory ' +
        'to WRITER_DIRS, or list the file in PASS_THROUGH_TABLE_WRITERS if it ' +
        'only writes rows its callers built.',
    ).toEqual([])
  })
})

describe('the vocabulary is derived, not restated', () => {
  it('reconcile-status takes the in-flight set from the declaration', () => {
    // The poller's set was a literal, and it drifted from the badge's table by
    // two values without anything failing. Reading the source keeps that from
    // silently coming back — an import cannot be half-done.
    const source = readFileSync(join(process.cwd(), 'src/lib/documents/reconcile-status.ts'), 'utf8')
    expect(source).toContain("import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'")
    expect(source).not.toMatch(/const IN_FLIGHT_STATUSES = new Set\(\[/)
  })

  it('the badge takes its variants and labels from the declaration', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/documents/components/document-status.tsx'),
      'utf8',
    )
    expect(source).toContain("from '@/lib/documents/document-status'")
    // The two `Record<string, …>` tables this replaced, by their old names.
    expect(source).not.toContain('const STATUS_VARIANT')
    expect(source).not.toContain('const STATUS_LABEL_KEY')
  })
})

describe('stored is terminal and neutral', () => {
  it('is never polled', () => {
    // No ingestion job was ever dispatched for an agent-authored report, so
    // nothing will ever report on it: a `stored` row in the in-flight set is a
    // spinner that never resolves, plus a backend call on every read.
    expect(IN_FLIGHT_DOCUMENT_STATUSES.has('stored')).toBe(false)
    expect(DOCUMENT_STATUS_FACTS.stored.phase).toBe('terminal')
  })

  it('is neither a success nor a failure', () => {
    // It must not read as either: the document is not in the knowledge base
    // (so not green — nothing can cite it) and nothing went wrong (so not red).
    expect(DOCUMENT_STATUS_FACTS.stored.variant).toBe('secondary')
  })

  it('leaves the states that ARE in flight alone', () => {
    expect([...IN_FLIGHT_DOCUMENT_STATUSES].sort()).toEqual([
      'ingesting',
      'pending',
      'processing',
      'uploading',
    ])
  })
})

describe('the declaration answers about values, not about prototypes', () => {
  it('does not mistake an Object.prototype key for a status', () => {
    // The lookup key comes from a text column, so `constructor` and `toString`
    // are values a row can hold. On a plain object they answer with something
    // truthy from the prototype, and every predicate downstream then reads
    // facts off a function.
    expect(documentStatusFacts('constructor')).toBeNull()
    expect(documentStatusFacts('toString')).toBeNull()
  })

  it('reads a status the way the column writes it', () => {
    expect(documentStatusFacts('READY')).toEqual(DOCUMENT_STATUS_FACTS.ready)
    expect(documentStatusFacts(null)).toBeNull()
    expect(documentStatusFacts('')).toBeNull()
  })
})

describe('every declared status has a label in both locales', () => {
  // `documentStatusLabel` calls `t(facts.labelKey)` with a value from the data
  // above, so the key never appears as a literal in a component and the
  // key-coverage scanner cannot see it. This is that check, for this table.
  it.each(KNOWN_DOCUMENT_STATUSES)('%s', (status) => {
    const key = DOCUMENT_STATUS_FACTS[status].labelKey
    expect(typeof getByPath(en.files, key), `en.files.${key}`).toBe('string')
    expect(typeof getByPath(de.files, key), `de.files.${key}`).toBe('string')
  })
})
