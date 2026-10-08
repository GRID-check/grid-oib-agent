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
 * ## Three layers
 *
 * 1. **Object readers.** Every top-level function in `src` that builds a
 *    `GetObjectCommand` or calls `getSignedUrl` is in {@link OBJECT_READERS}:
 *    either it records the hand-over itself (and says which `kind`), or it is
 *    exempt with the reason, written down. A function that calls
 *    `recordDocumentAccess` is in the table too, so the table is also the
 *    list of what is logged.
 * 2. **Pinned helpers.** A private helper several functions share
 *    ({@link PINNED_HELPERS}) is held to the exact list of its callers, so a new
 *    caller has to say whether it hands the bytes to a person.
 * 3. **Routes.** Every `app/api` route that reaches a logged function (by name,
 *    through any chain of functions in `src`), or builds a raw `Response`, is in
 *    {@link ROUTES}: logged through a named function, or exempt with the reason.
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
  'lib/storage/bucket.ts::readClaimOwner': { exempt: 'reads a bucket-claim marker object, not a document.' },
  'lib/s3.ts::presignForBackend': {
    exempt:
      'signs, against the in-network endpoint, the command its caller built for the backend, a machine. A caller that reads builds the GetObjectCommand itself and is classified here in its own right.',
  },
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
}

function topLevelFunctions(file: string): TopLevelFunction[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const rel = relative(SRC, file).replace(/\\/g, '/')
  const found: TopLevelFunction[] = []
  for (const statement of source.statements) {
    let name: string | null = null
    if (ts.isFunctionDeclaration(statement) && statement.name) name = statement.name.text
    else if (ts.isVariableStatement(statement)) name = statement.declarationList.declarations[0]?.name.getText() ?? null
    if (!name) continue
    const fn: TopLevelFunction = {
      key: `${rel}::${name}`,
      name,
      file: rel,
      identifiers: new Set(),
      callsRecord: false,
      recordedKinds: [],
      buildsObjectRead: false,
    }
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) fn.identifiers.add(node.text)
      if (ts.isNewExpression(node) && node.expression.getText() === 'GetObjectCommand') fn.buildsObjectRead = true
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText()
        if (callee === 'getSignedUrl') fn.buildsObjectRead = true
        if (callee === 'recordDocumentAccess') {
          fn.callsRecord = true
          const kind = node.arguments[2]
          if (kind && ts.isStringLiteralLike(kind)) fn.recordedKinds.push(kind.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(statement)
    found.push(fn)
  }
  return found
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

  it('every kind the table logs is used, and every kind in the type is logged by someone', () => {
    const used = new Set(
      Object.values(OBJECT_READERS).flatMap((disposition) => ('logged' in disposition ? disposition.logged : []))
    )
    expect([...used].sort()).toEqual([...DOWNLOAD_LOG_KINDS].sort())
  })
})

describe('download log coverage: routes', () => {
  /** Names of functions that hand bytes to a person (logged or reachable-by-browser exempt). */
  const seeds = new Set(
    Object.entries(OBJECT_READERS)
      .filter(([, disposition]) => 'logged' in disposition || ('servesPerson' in disposition && disposition.servesPerson))
      .map(([key]) => key.split('::')[1])
  )

  /** Everything in `src` that, through any chain of functions, reaches a seed by name. */
  function reaching(): Set<string> {
    const names = new Set(seeds)
    for (let grew = true; grew; ) {
      grew = false
      for (const fn of CALLERS) {
        // A route's own handler names (`GET`) are not functions anything calls.
        if (/^app\/api\/.*route\.ts$/.test(fn.file) || names.has(fn.name)) continue
        if ([...fn.identifiers].some((identifier) => identifier !== fn.name && names.has(identifier))) {
          names.add(fn.name)
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
