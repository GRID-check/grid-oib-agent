/**
 * @vitest-environment node
 */
/**
 * Every cross-tenant reader of a vote's words asks the database's one rule
 * (ADR-0092).
 *
 * A vote's `comment` and `expected_answer` can quote a folder with restricted
 * access, and every reader outside the voter's tenant (platform staff, the
 * digest's model, the lessons distiller, Langfuse) is outside that folder's
 * audience. Three repair rounds each found another reader that asked the wrong
 * thing. So the readers are found here, in the commit that adds one, the way
 * `download-log/coverage.spec.ts` finds what hands out a document's bytes: from
 * the syntax tree, not the text, so a comment naming a column is not a reader.
 *
 * - A **reader** is a unit of `src` (a top-level function, a declarator, a class
 *   member) whose SQL names `answer_feedback` together with `comment`,
 *   `expected_answer` or `*`, or whose drizzle query reads
 *   `answerFeedback.comment` / `.expectedAnswer` or the whole row (`select()`,
 *   `returning()` without a projection), or that hands the words to Langfuse
 *   (`upsertFeedbackScore`).
 * - A reader is **cross-tenant** when it is reached from the callback of a
 *   `withPlatformAccess(...)`, following calls by name.
 * - Every reader is classified in {@link READERS}: either it applies the rule
 *   (`OUTSIDE_RESTRICTED_USE`, `grid_feedback_restricted_use`, or for the
 *   Langfuse score `isRestrictedUseVote`), or it is tenant-scoped, with the
 *   reason. A tenant-scoped reader reached from a platform callback fails, and
 *   so does a reader nobody classified.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

type Classification = { rule: true } | { tenant: string }

/** `path::unit` → how it keeps a restricted folder's words from a reader outside its audience. */
const READERS: Record<string, Classification> = {
  'lib/feedback/repository.ts::upsertAnswerFeedback': {
    tenant: "The caller's own vote, written and returned in the caller's tenant.",
  },
  'lib/feedback/repository.ts::getAnswerFeedbackForUser': {
    tenant: "The caller's own prior vote, read in the caller's tenant before an upsert.",
  },
  'lib/feedback/repository.ts::listAnswerFeedbackForConversation': {
    tenant: "The caller's own votes in one conversation, for the chat's own hydration.",
  },
  'lib/feedback/repository.ts::listFeedbackTurns': { rule: true },
  'lib/feedback/service.ts::scoreVoteInLangfuse': { rule: true },
  'lib/platform-lessons/repository.ts::listUnprocessedDownvotes': { rule: true },
}

const RULE = /\bOUTSIDE_RESTRICTED_USE\b|\bgrid_feedback_restricted_use\b|\bisRestrictedUseVote\b/

interface Unit {
  key: string
  name: string
  node: ts.Node
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) && !/\.(spec|test)\.tsx?$/.test(file) && !file.endsWith('.d.ts')
    )
    .map((file) => join(dir, file))
}

/** Top-level functions, declarators and class members: each is its own unit. */
function unitsOf(rel: string, source: ts.SourceFile): Unit[] {
  const units: Unit[] = []
  const add = (name: string, node: ts.Node) => units.push({ key: `${rel}::${name}`, name, node })
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) add(statement.name?.text ?? 'default', statement)
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration)
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : 'member'
        add(`${statement.name?.text ?? 'default'}.${name}`, member)
      }
    }
  }
  return units
}

/** What a unit says in code: its literal and template text, and its property accesses. Comments are not in it. */
function codeOf(node: ts.Node): {
  sql: string
  accesses: string[]
  calls: string[]
  selectsWholeRow: boolean
} {
  const sql: string[] = []
  const accesses: string[] = []
  const calls: string[] = []
  let selectsWholeRow = false
  const visit = (child: ts.Node) => {
    // Template text only: SQL is written in `sql` templates, and a plain string
    // (a table definition's column name) is not a query.
    if (
      ts.isNoSubstitutionTemplateLiteral(child) ||
      ts.isTemplateHead(child) ||
      ts.isTemplateMiddle(child) ||
      ts.isTemplateTail(child)
    ) {
      sql.push(child.text)
    }
    if (ts.isPropertyAccessExpression(child)) accesses.push(child.getText())
    if (ts.isCallExpression(child)) {
      const callee = child.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      if (name) calls.push(name)
      if ((name === 'select' || name === 'returning') && child.arguments.length === 0)
        selectsWholeRow = true
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return { sql: sql.join('\n'), accesses, calls, selectsWholeRow }
}

function readsWords(unit: Unit): boolean {
  const code = codeOf(unit.node)
  if (
    /\banswer_feedback\b/i.test(code.sql) &&
    /\bcomment\b|\bexpected_answer\b|\bselect\s+\*|\bf\.\*/i.test(code.sql)
  ) {
    return true
  }
  if (code.accesses.some((access) => /^answerFeedback\.(comment|expectedAnswer)$/.test(access)))
    return true
  if (code.selectsWholeRow && identifiersOf(unit.node).includes('answerFeedback')) return true
  return code.calls.includes('upsertFeedbackScore')
}

/** Everything a unit names in code, so the rule's identifier and its SQL are both found. */
function codeText(unit: Unit): string {
  const code = codeOf(unit.node)
  return [code.sql, ...identifiersOf(unit.node)].join('\n')
}

interface Scan {
  readers: Map<string, Unit>
  byName: Map<string, Unit[]>
  units: Unit[]
}

function scan(): Scan {
  const readers = new Map<string, Unit>()
  const byName = new Map<string, Unit[]>()
  const units: Unit[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/')
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
    for (const unit of unitsOf(rel, source)) {
      units.push(unit)
      const short = unit.name.split('.').pop() ?? unit.name
      byName.set(short, [...(byName.get(short) ?? []), unit])
      if (readsWords(unit)) readers.set(unit.key, unit)
    }
  }
  return { readers, byName, units }
}

/** The units a platform callback reaches, following every name it mentions (stricter than calls alone). */
function reachedFromPlatformAccess({ units, byName }: Scan): Set<string> {
  const reached = new Set<string>()
  const queue: string[] = []
  for (const unit of units) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'withPlatformAccess'
      ) {
        // Every name the callback mentions: a function handed over by reference
        // (`withPlatformAccess(reason, sweep)`) is reached as surely as a call.
        for (const argument of node.arguments.slice(1)) queue.push(...identifiersOf(argument))
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.node)
  }
  const seenNames = new Set<string>()
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (seenNames.has(name)) continue
    seenNames.add(name)
    for (const unit of byName.get(name) ?? []) {
      if (reached.has(unit.key)) continue
      reached.add(unit.key)
      queue.push(...identifiersOf(unit.node))
    }
  }
  return reached
}

describe("every reader of a vote's words outside its tenant asks the rule (ADR-0092)", () => {
  const found = scan()
  const crossTenant = reachedFromPlatformAccess(found)

  it('finds the readers it knows, so a pattern that stopped matching fails here', () => {
    expect([...found.readers.keys()].sort()).toEqual(
      expect.arrayContaining(Object.keys(READERS).sort())
    )
  })

  it('has every reader classified: a new one says whether it reads across tenants', () => {
    const unclassified = [...found.readers.keys()].filter((key) => !(key in READERS))
    expect(unclassified, 'classify each in READERS (restricted-readers-coverage.spec.ts)').toEqual(
      []
    )
  })

  it('has every reader that applies the rule actually ask it', () => {
    const skipping = Object.entries(READERS)
      .filter(([, how]) => 'rule' in how)
      .map(([key]) => key)
      .filter((key) => {
        const unit = found.readers.get(key)
        return !unit || !RULE.test(codeText(unit))
      })
    expect(skipping).toEqual([])
  })

  it('reaches no tenant-scoped reader from a platform callback', () => {
    const leaking = Object.entries(READERS)
      .filter(([key, how]) => 'tenant' in how && crossTenant.has(key))
      .map(([key]) => key)
    expect(leaking).toEqual([])
  })

  it('finds the cross-tenant readers it must (not vacuous)', () => {
    for (const key of [
      'lib/feedback/repository.ts::listFeedbackTurns',
      'lib/platform-lessons/repository.ts::listUnprocessedDownvotes',
    ]) {
      expect(crossTenant.has(key), key).toBe(true)
    }
  })

  it('keeps the rule one database function, and the Langfuse score asks it too', () => {
    const unit = (key: string) => found.units.find((candidate) => candidate.key === key)
    const rule = unit('lib/feedback/repository.ts::OUTSIDE_RESTRICTED_USE')
    expect(rule && codeOf(rule.node).sql).toMatch(
      /not grid_feedback_restricted_use\(f\.organization_id, f\.message_id, f\.conversation_id\)/
    )
    // `scoreVoteInLangfuse` applies the rule through this; it must be the same one.
    const langfuse = unit('lib/feedback/repository.ts::isRestrictedUseVote')
    expect(langfuse && identifiersOf(langfuse.node)).toContain('OUTSIDE_RESTRICTED_USE')
  })
})

function identifiersOf(node: ts.Node): string[] {
  const names: string[] = []
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child)) names.push(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return names
}
