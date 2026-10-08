/**
 * @vitest-environment node
 */
/**
 * The download log's coverage gate: a function that hands a document's bytes to
 * a person cannot skip `recordDocumentAccess`, and a route that reaches one
 * cannot appear without being listed here.
 *
 * Same shape as `authz-coverage.spec.ts`: it reads the source, and a change
 * that adds a way out for bytes fails HERE, in the commit that adds it, naming
 * what to classify. It reads the syntax tree, not the text, so a comment that
 * mentions `GetObjectCommand` is not a reader and a renamed import still is.
 *
 * ## Four layers
 *
 * 1. **Object readers.** Every unit of `src` that builds a `GetObjectCommand`
 *    or calls `getSignedUrl` is in {@link OBJECT_READERS}. A unit is a top-level
 *    function (`default` for an anonymous default export), each declarator of a
 *    variable statement, each member of a class, a class expression or an
 *    object literal (`Owner.member`, nested ones on down: `Owner.api.member`),
 *    or any other statement that runs at the top of a module
 *    (`(top level, line N)`): every statement but a type, an import or a
 *    re-export, so none escapes the walk, and every function that can be
 *    called on its own is its own unit, so a check in one covers no other. Either
 *    it records the hand-over itself (and says which `kind`), or it is exempt
 *    with the reason, written down. A unit that calls `recordDocumentAccess` is
 *    in the table too, so the table is also the list of what is logged.
 * 2. **Pinned helpers.** A private helper several functions share
 *    ({@link PINNED_HELPERS}) is held to the exact list of its callers, so a new
 *    caller has to say whether it hands the bytes to a person.
 * 3. **Routes.** Every `app/api` route that reaches a logged function (by name,
 *    through any chain of functions in `src`), or builds a raw `Response`, is in
 *    {@link ROUTES}: logged through a named function, or exempt with the reason.
 * 4. **The access check comes first.** Every logged function asks
 *    `getAccessibleDocument` (itself, or through a function that does) before it
 *    reads, presigns or records anything. That is the one answer to "may this
 *    session have this document" (`lib/documents/access.ts`), so a reader that
 *    authorizes some other way, or after the bytes are on their way, fails here.
 *    A call is resolved to the function it names: one in the same file, one it
 *    imports (through re-exports, `import * as` and a default import), or, as
 *    `this.name()` in a class, that class's member. A method call on any other
 *    object resolves to nothing, so a same-named function elsewhere in `src`
 *    never stands in for it. A check counts only on the path every call takes:
 *    not under a branch (`if`, `?:`, `&&`, `||`, `??`, `?.`, a `case`), in a
 *    loop, in a `try` with a `catch`, or in a callback. And only when its result
 *    is used: not a statement of its own, not `void`, not the left of a comma,
 *    not a `const` nothing reads, and not a promise whose refusal a `.catch` (or
 *    a `.then` with a rejection handler) swallows anywhere along its chain
 *    (`check().then(f).catch(g)` as much as `check().catch(g)`).
 *
 *    What it cannot see: data flow beyond that. A check on a different id than
 *    the one whose bytes move, or one whose result is read and then not used for
 *    them, still passes. Layer 4 guards against a reader that forgets the check,
 *    makes it late or throws its answer away; it is not a proof, and review
 *    reads the arguments. Layer 3 follows names, so a route that reaches a
 *    default export under a name of its own is not followed there.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { DOWNLOAD_LOG_KINDS, type DownloadLogKind } from './kinds'

const SRC = join(process.cwd(), 'src')

type Disposition =
  | { logged: readonly DownloadLogKind[] }
  | {
      /** True when a person's browser can reach it, so a route that reaches it must be listed. */
      servesPerson?: true
      exempt: string
    }

/**
 * Every function that reads or presigns an object, or records one.
 * Key: `<path under src>::<function>`.
 */
const OBJECT_READERS: Record<string, Disposition> = {
  'lib/documents/service.ts::getDocumentDownload': { logged: ['download'] },
  'lib/documents/service.ts::getDocumentPreview': { logged: ['preview'] },
  'lib/documents/service.ts::streamDocumentFile': { logged: ['pdf'] },
  'lib/documents/service.ts::getDocumentTextPreview': { logged: ['text'] },
  'lib/documents/version-content.ts::readVersionContent': { logged: ['version'] },
  'lib/bim/model-service.ts::getModelSource': { logged: ['model'] },
  'lib/documents/service.ts::getDocumentThumbnail': {
    servesPerson: true,
    exempt:
      'a derived 200 px JPEG of the first page, not the file. It does not hand over the document, and a thumbnail on every card would fill the log with who scrolled past what.',
  },
  'lib/documents/service.ts::streamDocumentImage': {
    servesPerson: true,
    exempt:
      'the Next image optimizer fetches it with no session, so there is no person to name. The signed URL it checks is minted by getDocumentPreview, which records the open (a download of the original goes through getDocumentDownload).',
  },
  'lib/documents/version-content.ts::readObjectText': {
    exempt:
      'a private helper; its callers are pinned in PINNED_HELPERS (the person-facing one records, the agent-facing one serves the agent).',
  },
  'lib/bim/internal-access.ts::getInternalModelSource': {
    exempt: 'presigns the IFC for the agent’s model tool inside a turn; no person receives the bytes.',
  },
  'lib/bim/service.ts::fetchObject': { exempt: 'server-side IFC extraction reads the file to build the model; nothing is handed to a person.' },
  'lib/documents/rendition.ts::readOriginal': { exempt: 'server-side conversion of an office file to its PDF rendition.' },
  'lib/documents/service.ts::dispatchIngest': { exempt: 'presigns the file for the ingest backend, a machine.' },
  'lib/documents/service.ts::signedRenditionRef': { exempt: 'presigns the rendition for the ingest backend, a machine.' },
  'lib/documents/service.ts::presignDocumentImageUpload': { exempt: 'signs a PUT slot for an upload; it reads no document.' },
  'lib/storage/bucket.ts::readClaimOwner': { exempt: 'reads a bucket-claim marker object, not a document.' },
}

/**
 * Private helpers whose callers decide whether bytes reach a person. Key as above;
 * `callers` is every function in the same file that names the helper.
 */
const PINNED_HELPERS: Record<string, { callers: readonly string[]; reason: string }> = {
  'lib/documents/version-content.ts::readObjectText': {
    callers: ['fetchVersionText', 'readVersionForService'],
    reason:
      'fetchVersionText is wrapped by readVersionContent (records) and readVersionTextForTask (the revision task: the text goes to the model, not to the reviewer); readVersionForService serves the agent.',
  },
  'lib/documents/version-content.ts::fetchVersionText': {
    callers: ['readVersionContent', 'readVersionTextForTask'],
    reason: 'readVersionContent records the hand-over; readVersionTextForTask feeds an agent task and is exempt.',
  },
}

type RouteDisposition = { via: string } | { exempt: string }

/** Every `app/api` route that reaches a logged function or builds a raw `Response`. */
const ROUTES: Record<string, RouteDisposition> = {
  'documents/[id]/download/route.ts': { via: 'getDocumentDownload' },
  'documents/[id]/preview/route.ts': { via: 'getDocumentPreview' },
  'documents/[id]/file/route.ts': { via: 'streamDocumentFile' },
  'documents/[id]/text/route.ts': { via: 'getDocumentTextPreview' },
  'documents/[id]/versions/[versionId]/content/route.ts': { via: 'readVersionContent' },
  'documents/[id]/versions/diff/route.ts': { via: 'readVersionContent' },
  'bim/models/[modelId]/source/route.ts': { via: 'getModelSource' },
  'documents/[id]/thumbnail/route.ts': { exempt: 'a thumbnail, see OBJECT_READERS.getDocumentThumbnail' },
  'documents/[id]/image/route.ts': { exempt: 'signed capability URL with no session, see OBJECT_READERS.streamDocumentImage' },
  'projects/[id]/bim/checks/export/route.ts': { exempt: 'a BCF file generated from rule checks; it holds no stored document.' },
  'platform/answer-feedback/export/route.ts': { exempt: 'platform feedback export for the platform owner; no tenant document.' },
  'platform/citation-health/export/route.ts': { exempt: 'platform citation statistics export; no tenant document.' },
  'conversations/[id]/messages/[messageId]/export/route.ts': {
    exempt: 'renders one chat answer as a document; it is not a stored file, and the answer is the conversation’s own content.',
  },
  'conversations/[id]/live/route.ts': { exempt: 'server-sent events of a conversation.' },
  'stream/route.ts': { exempt: 'server-sent events.' },
  'health/route.ts': { exempt: 'the health probe; no files.' },
  'v1/[...path]/route.ts': { exempt: 'proxy of the allowlisted JSON endpoints of the agent service (lib/proxy/v1-allowlist); no file bytes.' },
  'knowledge-base/documents/[fileName]/route.ts': { exempt: 'the platform’s shared knowledge base (norms), served from the agent service; not an organization’s document.' },
  'internal/document-file/route.ts': { exempt: 'agent service only: tells it where an object is; it fetches the object itself for a turn.' },
  'internal/bim/source/route.ts': { exempt: 'agent service only: a presigned IFC for the model tool.' },
  'internal/document-versions/[versionId]/content/route.ts': { exempt: 'agent service only: opens a turn’s subject into its working directory.' },
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Dev previews are fixtures for pictures, never a route a customer reaches.
      if (path === join(SRC, 'app', 'dev')) continue
      sourceFiles(path, found)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

interface TopLevelFunction {
  key: string
  name: string
  file: string
  /** Every identifier the function mentions. */
  identifiers: Set<string>
  callsRecord: boolean
  /** The `kind` literals passed to `recordDocumentAccess`. */
  recordedKinds: string[]
  buildsObjectRead: boolean
  /**
   * What it calls (and `GetObjectCommand` when it builds one), in the order the
   * calls complete: a call's arguments finish before the call, so a call is
   * placed at its end. See {@link ResolvedCall}.
   */
  calls: ResolvedCall[]
}

/**
 * One call, resolved. `target` is `<path under src>::<function>` for a function
 * of `src` (declared in the same file, or imported, through re-exports), the
 * bare name for anything else called by plain name (a package import, a
 * global), and `?.<name>` for a method on some other object, which resolves to
 * nothing. `conditional`: the call is not on the path every call of the
 * function takes (see the module note, layer 4).
 */
interface ResolvedCall {
  target: string
  conditional: boolean
  /** Its result is thrown away ({@link resultDiscarded}): it answers nothing, so it is no check. */
  discarded: boolean
}

function topLevelFunctions(file: string): TopLevelFunction[] {
  return functionsInSource(relative(SRC, file).replace(/\\/g, '/'), readFileSync(file, 'utf8'))
}

/**
 * `src`-relative path of a module specifier, or null for a package. A module
 * that is not on disk (a spec's synthetic source) is taken to be `<base>.ts`.
 */
function moduleFile(fromRel: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = specifier.slice(2)
  else if (specifier.startsWith('.')) base = join(fromRel, '..', specifier).replace(/\\/g, '/')
  else return null
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(join(SRC, candidate))) ?? `${base}.ts`
}

const parsedSources = new Map<string, ts.SourceFile | null>()
function parsed(rel: string): ts.SourceFile | null {
  if (!parsedSources.has(rel)) {
    const path = join(SRC, rel)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null
    parsedSources.set(rel, text === null ? null : ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true))
  }
  return parsedSources.get(rel) ?? null
}

/** Whether a statement is the module's default export (`export default function`, `export default <expr>`). */
function isDefaultExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals
  if (!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) return false
  return (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) !== 0
}

/** The top-level names a module declares (functions, classes and `const`s), and `default` when it has a default export. */
function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (isDefaultExport(statement)) names.add('default')
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text)
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) names.add(declaration.name.getText())
  }
  return names
}

/** Where `name`, exported by module `rel`, is declared: through `export { a as b } from` and `export * from`. */
function declarationOf(rel: string, name: string, seen = new Set<string>()): string {
  const source = parsed(rel)
  if (!source || seen.has(rel) || declaredNames(source).has(name)) return `${rel}::${name}`
  seen.add(rel)
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = moduleFile(rel, statement.moduleSpecifier.text)
    const clause = statement.exportClause
    if (!target) continue
    if (!clause) {
      const found = declarationOf(target, name, seen)
      const declaring = parsed(found.split('::')[0])
      if (declaring && declaredNames(declaring).has(name)) return found
    } else if (ts.isNamedExports(clause)) {
      const spec = clause.elements.find((element) => element.name.text === name)
      if (spec) return declarationOf(target, (spec.propertyName ?? spec.name).text, seen)
    }
  }
  return `${rel}::${name}`
}

/** What each name a module imports from `src` is: a function key, or a namespace (`ns:` and its file). */
function importBindings(rel: string, source: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = moduleFile(rel, statement.moduleSpecifier.text)
    const clause = statement.importClause
    if (target && clause?.name) bindings.set(clause.name.text, declarationOf(target, 'default'))
    const named = clause?.namedBindings
    if (!target || !named) continue
    if (ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, `ns:${target}`)
      continue
    }
    for (const element of named.elements) {
      bindings.set(element.name.text, declarationOf(target, (element.propertyName ?? element.name).text))
    }
  }
  return bindings
}

const SHORT_CIRCUIT = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/** Whether `child`, directly under `parent`, runs on only some of the paths through `parent`. */
function branches(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isIfStatement(parent)) return child !== parent.expression
  if (ts.isConditionalExpression(parent)) return child !== parent.condition
  if (ts.isBinaryExpression(parent)) return SHORT_CIRCUIT.has(parent.operatorToken.kind) && child === parent.right
  if (ts.isTryStatement(parent)) return parent.catchClause !== undefined && child === parent.tryBlock
  return ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isCatchClause(parent) || ts.isIterationStatement(parent, false)
}

/** A node that hands its operand's value on unchanged, as far as a check's result goes. */
function transparent(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
}

/** The method `access` names, `p.then` and `p['then']` alike; null for anything else. */
function accessedMethod(access: ts.Node, on: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(access) && access.expression === on) return access.name.text
  if (!ts.isElementAccessExpression(access) || access.expression !== on) return null
  return ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : null
}

/**
 * Whether a call's result is thrown away, so a refusal it carries stops
 * nothing: a statement of its own (`await check(…)`, `void check(…)`), the
 * left of a comma, a `.catch(…)` (or a `.then` with a rejection handler)
 * anywhere along its promise chain, or a `const` nothing reads. The chain is
 * followed through every `.then(onFulfilled)` and `.finally(…)`, which pass a
 * refusal on, so `check().then(f).catch(g)` swallows it as surely as
 * `check().catch(g)`, and the chain's last value is what the rest is asked of.
 * `getAccessibleDocument` refuses by throwing, so most of these still refuse;
 * they are passed over all the same, because a check whose document is never
 * used is usually a check on something other than what moves (module note,
 * layer 4).
 */
function resultDiscarded(call: ts.CallExpression, root: ts.Node): boolean {
  let node: ts.Node = call
  for (;;) {
    while (transparent(node.parent)) node = node.parent
    const method = accessedMethod(node.parent, node)
    if (method === 'catch') return true
    const chained = node.parent.parent
    if ((method !== 'then' && method !== 'finally') || !ts.isCallExpression(chained) || chained.expression !== node.parent) break
    if (method === 'then' && chained.arguments.length > 1) return true
    node = chained
  }
  const parent = node.parent
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken) return parent.left === node
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== node) return false
  return !bindingNames(parent.name).some((name) => readElsewhere(root, name))
}

/** The names a declaration binds, through destructuring. */
function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
}

/** Whether `root` mentions the name `declared` binds anywhere but in that declaration. */
function readElsewhere(root: ts.Node, declared: ts.Identifier): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node !== declared && node.text === declared.text) found = true
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** A property's or member's name as its key spells it: `get`, `'x'`, `#x`, `[computed]`. */
function propertyKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return name.getText()
}

/** A member's name as its key spells it: `get`, `constructor`, `[computed]`, `static`. */
function memberName(member: ts.ClassElement): string | null {
  if (ts.isConstructorDeclaration(member)) return 'constructor'
  if (ts.isClassStaticBlockDeclaration(member)) return 'static'
  return member.name ? propertyKey(member.name) : null
}

/**
 * One unit the walk reads, named for its key: a function declaration (its name,
 * or `default`), each declarator of a variable statement (its name), each
 * member of a class, class expression or object literal (`Owner.member`,
 * `default.member` for an anonymous default class or object, and on down for
 * one nested in another), a default export of an expression (`default`), and
 * any other statement that runs code at the top of the module
 * (`(top level, line N)`). Every statement but a type, an import or a re-export
 * is one, so a call to a byte step cannot sit where the walk does not look; and
 * every function that can be called on its own is a unit of its own, so the
 * first check in one never covers another.
 */
interface Unit {
  name: string
  node: ts.Node
  /** The class (or object literal) whose `this` the unit's calls resolve against. */
  className?: string
  /**
   * The function the unit is. Every other function inside the unit is a
   * callback, which may run later, many times, or never; a unit with no root
   * (a static block, a top-level statement, a value built by a call) has only
   * callbacks.
   */
  root?: ts.Node
}

/** An expression without what does not change which value it is: parentheses, `as`, `satisfies`, `!`, `<T>`. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let node = expression
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression
  }
  return node
}

/**
 * The units a value bound to `name` is: one per member of a class expression or
 * an object literal, one rooted at a function, and otherwise one with no root.
 */
function unitsOfValue(name: string, node: ts.Node, value: ts.Expression | undefined, className?: string): Unit[] {
  const inner = value === undefined ? undefined : unwrapped(value)
  if (inner && ts.isClassExpression(inner)) return classUnits(name, inner)
  if (inner && ts.isObjectLiteralExpression(inner)) return objectUnits(name, inner)
  return [
    {
      name,
      node,
      ...(className === undefined ? {} : { className }),
      ...(inner && ts.isFunctionLike(inner) ? { root: inner } : {}),
    },
  ]
}

function classUnits(className: string, declaration: ts.ClassLikeDeclaration): Unit[] {
  return declaration.members.flatMap((member): Unit[] => {
    const name = memberName(member)
    if (name === null || ts.isIndexSignatureDeclaration(member)) return []
    const key = `${className}.${name}`
    if (ts.isPropertyDeclaration(member)) return unitsOfValue(key, member, member.initializer, className)
    return [{ name: key, node: member, className, ...(ts.isFunctionLike(member) ? { root: member } : {}) }]
  })
}

function objectUnits(owner: string, literal: ts.ObjectLiteralExpression): Unit[] {
  return literal.properties.flatMap((property): Unit[] => {
    if (ts.isSpreadAssignment(property)) {
      const line = property.getSourceFile().getLineAndCharacterOfPosition(property.getStart()).line + 1
      return [{ name: `${owner}.(spread, line ${line})`, node: property }]
    }
    // A shorthand property holds a name and runs nothing.
    if (ts.isShorthandPropertyAssignment(property)) return []
    const key = `${owner}.${propertyKey(property.name)}`
    if (ts.isPropertyAssignment(property)) return unitsOfValue(key, property, property.initializer, owner)
    return [{ name: key, node: property, className: owner, root: property }]
  })
}

function unitsOf(source: ts.SourceFile, statement: ts.Statement): Unit[] {
  if (ts.isFunctionDeclaration(statement)) {
    if (!statement.body) return []
    return [{ name: statement.name?.text ?? 'default', node: statement, root: statement }]
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      unitsOfValue(declaration.name.getText(), declaration, declaration.initializer)
    )
  }
  if (ts.isClassDeclaration(statement)) return classUnits(statement.name?.text ?? 'default', statement)
  if (ts.isExportAssignment(statement)) return unitsOfValue('default', statement, statement.expression)
  if (
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  ) {
    return []
  }
  const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1
  return [{ name: `(top level, line ${line})`, node: statement }]
}

function functionsInSource(rel: string, text: string): TopLevelFunction[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  const locals = declaredNames(source)
  const imports = importBindings(rel, source)
  /**
   * `foo()` and `ns.foo()` to the function they name, `this.foo()` in a class
   * to that class's member; a method on anything else to nothing.
   */
  const resolve = (expression: ts.Expression, className: string | undefined): string | null => {
    if (ts.isIdentifier(expression)) {
      if (locals.has(expression.text)) return `${rel}::${expression.text}`
      return imports.get(expression.text) ?? expression.text
    }
    if (!ts.isPropertyAccessExpression(expression)) return null
    if (className && expression.expression.kind === ts.SyntaxKind.ThisKeyword) return `${rel}::${className}.${expression.name.text}`
    const owner = ts.isIdentifier(expression.expression) ? imports.get(expression.expression.text) : undefined
    if (owner?.startsWith('ns:')) return declarationOf(owner.slice(3), expression.name.text)
    return `?.${expression.name.text}`
  }
  const found: TopLevelFunction[] = []
  for (const unit of source.statements.flatMap((statement) => unitsOf(source, statement))) {
    const { name, className } = unit
    const fn: TopLevelFunction = {
      key: `${rel}::${name}`,
      name,
      file: rel,
      identifiers: new Set(),
      callsRecord: false,
      recordedKinds: [],
      buildsObjectRead: false,
      calls: [],
    }
    const ordered: Array<ResolvedCall & { end: number }> = []
    // The unit's own function is the one being read; any other function inside
    // it is a callback ({@link Unit.root}).
    const visit = (node: ts.Node, conditional: boolean): void => {
      if (ts.isIdentifier(node)) fn.identifiers.add(node.text)
      if (ts.isNewExpression(node) && node.expression.getText() === 'GetObjectCommand') fn.buildsObjectRead = true
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const target = resolve(node.expression, className)
        const optional = ts.isCallExpression(node) && node.questionDotToken !== undefined
        const discarded = ts.isCallExpression(node) && resultDiscarded(node, unit.node)
        if (target) ordered.push({ end: node.getEnd(), target, conditional: conditional || optional, discarded })
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText()
        if (callee === 'getSignedUrl') fn.buildsObjectRead = true
        if (callee === 'recordDocumentAccess') {
          fn.callsRecord = true
          const kind = node.arguments[2]
          if (kind && ts.isStringLiteralLike(kind)) fn.recordedKinds.push(kind.text)
        }
      }
      const callback = ts.isFunctionLike(node) && node !== unit.root
      ts.forEachChild(node, (child) => visit(child, conditional || callback || branches(node, child)))
    }
    visit(unit.node, false)
    fn.calls = ordered
      .sort((a, b) => a.end - b.end)
      .map(({ target, conditional, discarded }) => ({ target, conditional, discarded }))
    found.push(fn)
  }
  return found
}

/** The one access decision for a document (`lib/documents/access.ts`), as a resolved call target. */
const ACCESS_CHECK = 'lib/documents/access.ts::getAccessibleDocument'
/** What reads, presigns or records a document's bytes directly. */
const BYTE_STEPS = new Set(['GetObjectCommand', 'getSignedUrl', 'lib/download-log/service.ts::recordDocumentAccess'])

/**
 * The functions (by key) that ask {@link ACCESS_CHECK} before anything reaches
 * bytes: among the calls each makes, in order, the first that is either an
 * access check (`getAccessibleDocument`, or a function already in this set) on
 * the path every call takes, or a byte step (a read, a presign, a record, or a
 * call to a function that does one without asking first), is an access check.
 * A check under a branch is passed over, not counted. Calls are resolved to
 * the function they name ({@link ResolvedCall}), to a fixed point.
 */
function accessCheckedFirst(functions: readonly TopLevelFunction[]): Set<string> {
  const reads = new Set(functions.filter((fn) => fn.buildsObjectRead || fn.callsRecord).map((fn) => fn.key))
  for (let grew = true; grew; ) {
    grew = false
    for (const fn of functions) {
      if (reads.has(fn.key) || !fn.calls.some(({ target }) => target !== fn.key && reads.has(target))) continue
      reads.add(fn.key)
      grew = true
    }
  }
  const checked = new Set<string>()
  const asks = (call: ResolvedCall): boolean =>
    !call.conditional && !call.discarded && (call.target === ACCESS_CHECK || checked.has(call.target))
  for (let grew = true; grew; ) {
    grew = false
    for (const fn of functions) {
      if (checked.has(fn.key)) continue
      const first = fn.calls.find(
        (call) => call.target !== fn.key && (asks(call) || BYTE_STEPS.has(call.target) || reads.has(call.target))
      )
      if (!first || !asks(first)) continue
      checked.add(fn.key)
      grew = true
    }
  }
  return checked
}

const FILES = sourceFiles(SRC)
const ALL_FUNCTIONS = FILES.flatMap(topLevelFunctions)
const ROUTE_FILES = FILES.filter((file) => /[\\/]app[\\/]api[\\/].*route\.ts$/.test(file))
const ROUTE_KEY = (file: string): string => relative(join(SRC, 'app', 'api'), file).replace(/\\/g, '/')

/** The `recordDocumentAccess` definition and its own module are not call sites. */
const LOG_MODULE = 'lib/download-log/'
const CALLERS = ALL_FUNCTIONS.filter((fn) => !fn.file.startsWith(LOG_MODULE))

describe('download log coverage: object readers', () => {
  it('finds the source (a broken walk would make every check vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(500)
    expect(CALLERS.some((fn) => fn.key === 'lib/documents/service.ts::getDocumentDownload')).toBe(true)
  })

  it('classifies every function that builds an object read or presign, and every function that records', () => {
    const found = CALLERS.filter((fn) => fn.buildsObjectRead || fn.callsRecord).map((fn) => fn.key).sort()
    expect(
      found,
      'A function now reads or presigns an object (or records a hand-over) and is not in OBJECT_READERS. ' +
        'If a person receives the bytes, call recordDocumentAccess before they leave and list it as logged; ' +
        'if not, list it as exempt with the reason.'
    ).toEqual(Object.keys(OBJECT_READERS).sort())
  })

  it('every logged function records exactly the kinds it declares, and every kind is known', () => {
    for (const [key, disposition] of Object.entries(OBJECT_READERS)) {
      if (!('logged' in disposition)) continue
      const fn = CALLERS.find((candidate) => candidate.key === key)
      expect([...new Set(fn?.recordedKinds)].sort(), key).toEqual([...disposition.logged].sort())
      for (const kind of disposition.logged) expect(DOWNLOAD_LOG_KINDS, key).toContain(kind)
    }
  })

  it('no exempt function records (an exemption that records is a mislabelled one)', () => {
    for (const [key, disposition] of Object.entries(OBJECT_READERS)) {
      if (!('exempt' in disposition)) continue
      expect(CALLERS.find((fn) => fn.key === key)?.callsRecord, key).toBe(false)
      expect(disposition.exempt.length, key).toBeGreaterThan(20)
    }
  })

  it('every pinned helper has exactly the callers it lists', () => {
    for (const [key, pin] of Object.entries(PINNED_HELPERS)) {
      const [file, helper] = key.split('::')
      const callers = CALLERS.filter((fn) => fn.file === file && fn.name !== helper && fn.identifiers.has(helper))
        .map((fn) => fn.name)
        .sort()
      expect(callers, `${key}: ${pin.reason}`).toEqual([...pin.callers].sort())
    }
  })

  it('every logged function asks getAccessibleDocument before it reads, presigns or records', () => {
    const checked = accessCheckedFirst(CALLERS)
    const logged = Object.entries(OBJECT_READERS)
      .filter(([, disposition]) => 'logged' in disposition)
      .map(([key]) => key)
    expect(
      logged.filter((key) => !checked.has(key)),
      'A function records a hand-over without first asking getAccessibleDocument (itself or through a function ' +
        'that does). That call is the one access decision for a document; authorize through it before the bytes move.'
    ).toEqual([])
  })

  it('the access-check order is read from the code, not assumed (it fails a reader that checks late or elsewhere)', () => {
    const functions = functionsInSource(
      'lib/example.ts',
      `
      import { getAccessibleDocument } from '@/lib/documents/access'
      import { recordDocumentAccess } from '@/lib/download-log/service'
      import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
      async function load(session, id) { return getAccessibleDocument(session, id) }
      export async function viaHelper(session, id) { const doc = await load(session, id); await recordDocumentAccess(session, doc, 'download') }
      export async function direct(session, id) { const doc = await getAccessibleDocument(session, id); await getSignedUrl(s3, new GetObjectCommand({ Key: doc.storageKey })) }
      export async function late(session, id) { const url = await getSignedUrl(s3, new GetObjectCommand({})); await getAccessibleDocument(session, id); return url }
      export async function elsewhere(session, id) { await getAccessibleModel(session, id); await recordDocumentAccess(session, null, 'model') }
      export async function nested(session, id) { await recordDocumentAccess(session, await getAccessibleDocument(session, id), 'pdf') }
      export async function inCondition(session, id) { if (!(await getAccessibleDocument(session, id))) throw new Error(); await recordDocumentAccess(session, null, 'pdf') }
      `
    )
    const checked = accessCheckedFirst(functions)
    const key = (name: string) => `lib/example.ts::${name}`
    expect(['load', 'viaHelper', 'direct', 'nested', 'inCondition'].filter((name) => !checked.has(key(name)))).toEqual([])
    expect(['late', 'elsewhere'].filter((name) => checked.has(key(name)))).toEqual([])
  })

  it('resolves a call to the function it names, so a same-named check elsewhere in src or a method on another object does not count', () => {
    const functions = [
      // Another file's `load` asks first; this file's `load` does not.
      ...functionsInSource(
        'lib/other.ts',
        `
        import { getAccessibleDocument } from '@/lib/documents/access'
        export async function load(session, id) { return getAccessibleDocument(session, id) }
        `
      ),
      ...functionsInSource(
        'lib/example.ts',
        `
        import { recordDocumentAccess } from '@/lib/download-log/service'
        import * as other from './other'
        import { load as checkedLoad } from './other'
        async function load(session, id) { return cache.get(id) }
        export async function sameName(session, id) { await load(session, id); await recordDocumentAccess(session, null, 'pdf') }
        export async function method(session, id) { await store.load(session, id); await recordDocumentAccess(session, null, 'pdf') }
        export async function imported(session, id) { const doc = await checkedLoad(session, id); await recordDocumentAccess(session, doc, 'pdf') }
        export async function namespace(session, id) { const doc = await other.load(session, id); await recordDocumentAccess(session, doc, 'pdf') }
        `
      ),
    ]
    const checked = accessCheckedFirst(functions)
    const key = (name: string) => `lib/example.ts::${name}`
    expect(['sameName', 'method'].filter((name) => checked.has(key(name)))).toEqual([])
    expect(['imported', 'namespace'].filter((name) => !checked.has(key(name)))).toEqual([])
  })

  it('counts a check only on the path every call takes: not under a branch, in a swallowing try, or in a callback', () => {
    const functions = functionsInSource(
      'lib/example.ts',
      `
      import { getAccessibleDocument } from '@/lib/documents/access'
      import { recordDocumentAccess } from '@/lib/download-log/service'
      export async function guarded(session, id) { if (!cached) await getAccessibleDocument(session, id); await recordDocumentAccess(session, null, 'pdf') }
      export async function ternary(session, id) { const doc = cached ? cached : await getAccessibleDocument(session, id); await recordDocumentAccess(session, doc, 'pdf') }
      export async function shortCircuit(session, id) { const doc = cached ?? (await getAccessibleDocument(session, id)); await recordDocumentAccess(session, doc, 'pdf') }
      export async function swallowed(session, id) { try { await getAccessibleDocument(session, id) } catch {} await recordDocumentAccess(session, null, 'pdf') }
      export async function callback(session, ids) { ids.forEach((id) => getAccessibleDocument(session, id)); await recordDocumentAccess(session, null, 'pdf') }
      export async function finallyOnly(session, id) { let doc; try { doc = await getAccessibleDocument(session, id) } finally { done() } await recordDocumentAccess(session, doc, 'pdf') }
      export async function thenUnconditional(session, id) { if (x) await getAccessibleDocument(session, id); const doc = await getAccessibleDocument(session, id); await recordDocumentAccess(session, doc, 'pdf') }
      `
    )
    const checked = accessCheckedFirst(functions)
    const key = (name: string) => `lib/example.ts::${name}`
    expect(
      ['guarded', 'ternary', 'shortCircuit', 'swallowed', 'callback'].filter((name) => checked.has(key(name)))
    ).toEqual([])
    expect(['finallyOnly', 'thenUnconditional'].filter((name) => !checked.has(key(name)))).toEqual([])
  })

  it('counts no check whose result is thrown away or whose refusal is caught', () => {
    const functions = functionsInSource(
      'lib/example.ts',
      `
      import { getAccessibleDocument } from '@/lib/documents/access'
      import { recordDocumentAccess } from '@/lib/download-log/service'
      export async function statement(session, id, other) { await getAccessibleDocument(session, id); await recordDocumentAccess(session, other, 'pdf') }
      export async function voided(session, id, other) { void getAccessibleDocument(session, id); await recordDocumentAccess(session, other, 'pdf') }
      export async function comma(session, id, other) { const doc = (await getAccessibleDocument(session, id), other); await recordDocumentAccess(session, doc, 'pdf') }
      export async function unread(session, id, other) { const doc = await getAccessibleDocument(session, id); await recordDocumentAccess(session, other, 'pdf') }
      export async function caught(session, id) { const doc = await getAccessibleDocument(session, id).catch(() => null); await recordDocumentAccess(session, doc, 'pdf') }
      export async function rejectionHandled(session, id) { const doc = await getAccessibleDocument(session, id).then((found) => found, () => null); await recordDocumentAccess(session, doc, 'pdf') }
      export async function read(session, id) { const doc = await getAccessibleDocument(session, id); await recordDocumentAccess(session, doc, 'pdf') }
      export async function destructured(session, id) { const { folderId } = await getAccessibleDocument(session, id); await recordDocumentAccess(session, { folderId }, 'pdf') }
      export async function chained(session, id) { const doc = await getAccessibleDocument(session, id).then((found) => found); await recordDocumentAccess(session, doc, 'pdf') }
      export async function caughtDownChain(session, id) { const doc = await getAccessibleDocument(session, id).then((found) => found).catch(() => null); await recordDocumentAccess(session, doc, 'pdf') }
      export async function caughtAfterFinally(session, id) { const doc = await getAccessibleDocument(session, id).finally(done).then((found) => found).catch(() => null); await recordDocumentAccess(session, doc, 'pdf') }
      export async function caughtByElement(session, id) { const doc = await getAccessibleDocument(session, id).then((found) => found)['catch'](() => null); await recordDocumentAccess(session, doc, 'pdf') }
      export async function chainAsStatement(session, id, other) { await getAccessibleDocument(session, id).then((found) => found); await recordDocumentAccess(session, other, 'pdf') }
      export async function finallyRead(session, id) { const doc = await getAccessibleDocument(session, id).finally(done); await recordDocumentAccess(session, doc, 'pdf') }
      `
    )
    const checked = accessCheckedFirst(functions)
    const key = (name: string) => `lib/example.ts::${name}`
    expect(
      [
        'statement',
        'voided',
        'comma',
        'unread',
        'caught',
        'rejectionHandled',
        'caughtDownChain',
        'caughtAfterFinally',
        'caughtByElement',
        'chainAsStatement',
      ].filter((name) => checked.has(key(name)))
    ).toEqual([])
    expect(['read', 'destructured', 'chained', 'finallyRead'].filter((name) => !checked.has(key(name)))).toEqual([])
  })

  it('reads each function a class expression, an object literal or a declarator list holds as its own unit, so one check covers no other', () => {
    const functions = functionsInSource(
      'lib/example.ts',
      `
      import { getAccessibleDocument } from '@/lib/documents/access'
      import { recordDocumentAccess } from '@/lib/download-log/service'
      export const Reader = class {
        async load(session, id) { return getAccessibleDocument(session, id) }
        async serve(session, doc) { await recordDocumentAccess(session, doc, 'pdf') }
      }
      export const api = {
        async load(session, id) { return getAccessibleDocument(session, id) },
        serve: async (session, doc) => { await recordDocumentAccess(session, doc, 'pdf') },
        checked: async function (session, id) { const doc = await this.load(session, id); await recordDocumentAccess(session, doc, 'pdf') },
      }
      export const first = async (session, id) => getAccessibleDocument(session, id), second = async (session, doc) => { await recordDocumentAccess(session, doc, 'pdf') }
      export class Holder {
        static api = {
          async load(session, id) { return getAccessibleDocument(session, id) },
          async serve(session, doc) { await recordDocumentAccess(session, doc, 'pdf') },
        }
      }
      export default {
        async load(session, id) { return getAccessibleDocument(session, id) },
        async serve(session, doc) { await recordDocumentAccess(session, doc, 'pdf') },
      }
      export const wrapped = wrap({
        async load(session, id) { return getAccessibleDocument(session, id) },
        async serve(session, doc) { await recordDocumentAccess(session, doc, 'pdf') },
      })
      `
    )
    const recording = functions.filter((fn) => fn.callsRecord).map((fn) => fn.key.replace('lib/example.ts::', ''))
    expect(recording.sort()).toEqual(
      ['Holder.api.serve', 'Reader.serve', 'api.checked', 'api.serve', 'default.serve', 'second', 'wrapped'].sort()
    )
    // Only the member that asks first itself (through `this.load`, its own object's member) is checked. A
    // value built by a call (`wrap({…})`) is no function of its own, so nothing inside it counts as a check.
    const checked = accessCheckedFirst(functions)
    expect(recording.filter((name) => checked.has(`lib/example.ts::${name}`))).toEqual(['api.checked'])
  })

  it('reads class methods, default exports and top-level code, so a byte step cannot sit where the walk does not look', () => {
    const functions = functionsInSource(
      'lib/example.ts',
      `
      import { getAccessibleDocument } from '@/lib/documents/access'
      import { recordDocumentAccess } from '@/lib/download-log/service'
      import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
      export class Reader {
        async load(session, id) { return getAccessibleDocument(session, id) }
        async checked(session, id) { const doc = await this.load(session, id); await recordDocumentAccess(session, doc, 'pdf') }
        async unchecked(session, doc) { await recordDocumentAccess(session, doc, 'preview') }
        presign = async () => getSignedUrl(s3, new GetObjectCommand({}))
        static { getSignedUrl(s3, new GetObjectCommand({})) }
      }
      export default async function (session, doc) { await recordDocumentAccess(session, doc, 'download') }
      void getSignedUrl(s3, new GetObjectCommand({}))
      `
    )
    const byKey = new Map(functions.map((fn) => [fn.key.replace('lib/example.ts::', ''), fn]))
    expect(
      [...byKey].filter(([, fn]) => fn.callsRecord || fn.buildsObjectRead).map(([name]) => name).sort()
    ).toEqual(['(top level, line 13)', 'Reader.checked', 'Reader.presign', 'Reader.static', 'Reader.unchecked', 'default'])
    expect(byKey.get('default')?.recordedKinds).toEqual(['download'])
    // `this.load` resolves to the class's own member, which asks first.
    const checked = accessCheckedFirst(functions)
    expect(['Reader.checked'].filter((name) => !checked.has(`lib/example.ts::${name}`))).toEqual([])
    expect(['Reader.unchecked', 'default'].filter((name) => checked.has(`lib/example.ts::${name}`))).toEqual([])
  })

  it('resolves a default import to the default export it names', () => {
    const functions = [
      ...functionsInSource(
        'lib/other.ts',
        `
        import { getAccessibleDocument } from '@/lib/documents/access'
        export default async function (session, id) { return getAccessibleDocument(session, id) }
        `
      ),
      ...functionsInSource(
        'lib/example.ts',
        `
        import { recordDocumentAccess } from '@/lib/download-log/service'
        import load from './other'
        export async function viaDefault(session, id) { const doc = await load(session, id); await recordDocumentAccess(session, doc, 'pdf') }
        `
      ),
    ]
    expect(accessCheckedFirst(functions).has('lib/example.ts::viaDefault')).toBe(true)
  })

  it('every kind the table logs is used, and every kind in the type is logged by someone', () => {
    const used = new Set(
      Object.values(OBJECT_READERS).flatMap((disposition) => ('logged' in disposition ? disposition.logged : []))
    )
    expect([...used].sort()).toEqual([...DOWNLOAD_LOG_KINDS].sort())
  })
})

describe('download log coverage: routes', () => {
  /** The name a caller writes for a unit: a class member's own name (`get` of `Reader.get`). */
  const calledAs = (name: string): string => name.slice(name.lastIndexOf('.') + 1)

  /** Names of functions that hand bytes to a person (logged or reachable-by-browser exempt). */
  const seeds = new Set(
    Object.entries(OBJECT_READERS)
      .filter(([, disposition]) => 'logged' in disposition || ('servesPerson' in disposition && disposition.servesPerson))
      .map(([key]) => calledAs(key.split('::')[1]))
  )

  /** Everything in `src` that, through any chain of functions, reaches a seed by name. */
  function reaching(): Set<string> {
    const names = new Set(seeds)
    for (let grew = true; grew; ) {
      grew = false
      for (const fn of CALLERS) {
        // A route's own handler names (`GET`) are not functions anything calls.
        const name = calledAs(fn.name)
        if (/^app\/api\/.*route\.ts$/.test(fn.file) || names.has(name)) continue
        if ([...fn.identifiers].some((identifier) => identifier !== name && names.has(identifier))) {
          names.add(name)
          grew = true
        }
      }
    }
    return names
  }

  const RAW_RESPONSE = /new (Next)?Response\(|\bstreamKnowledgeBaseDocument\b/

  function detectedRoutes(): string[] {
    const names = reaching()
    return ROUTE_FILES.filter((file) => {
      const text = readFileSync(file, 'utf8')
      if (RAW_RESPONSE.test(text)) return true
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      let reached = false
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && names.has(node.text)) reached = true
        ts.forEachChild(node, visit)
      }
      visit(source)
      return reached
    })
      .map(ROUTE_KEY)
      .sort()
  }

  it('finds the route surface', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(100)
  })

  it('lists every route that reaches a logged function, serves a thumbnail or image, or builds a raw Response', () => {
    const listed = new Set(Object.keys(ROUTES))
    const missing = detectedRoutes().filter((route) => !listed.has(route))
    expect(
      missing,
      'These routes can hand file bytes to a person and are not in ROUTES. Name the logged function they go ' +
        'through (`via`), or exempt them with the reason.'
    ).toEqual([])
  })

  it('the detection sees the routes that go through a logged function (it is not vacuous)', () => {
    const detected = new Set(detectedRoutes())
    const logged = Object.entries(ROUTES)
      .filter(([, disposition]) => 'via' in disposition)
      .map(([route]) => route)
    expect(logged.filter((route) => !detected.has(route))).toEqual([])
  })

  it('every listed route exists and names a function it really reaches', () => {
    for (const [route, disposition] of Object.entries(ROUTES)) {
      const file = join(SRC, 'app', 'api', route)
      expect(existsSync(file), route).toBe(true)
      if ('via' in disposition) {
        expect(readFileSync(file, 'utf8'), route).toContain(disposition.via)
        const target = Object.entries(OBJECT_READERS).find(
          ([key, entry]) => key.endsWith(`::${disposition.via}`) && 'logged' in entry
        )
        expect(target, `${route} goes through ${disposition.via}, which must be a logged function`).toBeDefined()
      } else {
        expect(disposition.exempt.length, route).toBeGreaterThan(15)
      }
    }
  })
})
