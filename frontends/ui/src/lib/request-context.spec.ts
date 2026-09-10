/**
 * @vitest-environment node
 */
import fixtureData from '../../tests/fixtures/grid_request_context.json'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  buildGridRequestContextEnvelope,
  buildGridRequestContextEnvelopeHeaders,
  buildGridRequestContextEnvelopePayload,
  buildGridRequestContextHeaders,
  buildGridRequestContextWireHeaders,
  encodeGridBudgetHeader,
  encodeGridJsonHeader,
  encodeGridTextHeader,
  encodeModelOverridesHeader,
  GRID_HEADER_NAMES,
  GRID_REQUEST_CONTEXT_MAX_AGE_MS,
  signGridRequestContextEnvelope,
  verifyGridRequestContextEnvelope,
  type GridRequestContextInput,
} from './request-context'

/**
 * Cross-language contract fixture (backlog T3-9): the canonical wire values
 * this builder must produce. Lives at `frontends/ui/tests/fixtures/` — a
 * byte-identical twin of repo-root `tests/fixtures/grid_request_context.json`
 * (see that file's header comment for why the twin exists: the frontend
 * typecheck/test Docker build context, `frontends/ui/Dockerfile.typecheck`,
 * is scoped to `frontends/ui` and cannot COPY files from outside it). The
 * Python side (`tests/aiq_agent/test_project_context.py`) parses the same
 * cases from the repo-root copy in the opposite direction.
 */
interface GridRequestContextFixtureCase {
  name: string
  comment?: string
  input: GridRequestContextInput
  headers: Record<string, string>
}

interface GridRequestContextEnvelopeFixtureCase {
  name: string
  comment?: string
  secret: string
  input: GridRequestContextInput
  envelopeJson: string
  header: string
  signature: string
}

interface GridRequestContextFixture {
  cases: GridRequestContextFixtureCase[]
  envelopeCases: GridRequestContextEnvelopeFixtureCase[]
}

// Import the fixture directly (vite/resolveJsonModule) rather than reading it
// via fileURLToPath(import.meta.url) — under vitest that URL is not always a
// file: scheme, which crashed this whole suite at import time.
const fixture: GridRequestContextFixture = fixtureData as GridRequestContextFixture

describe('buildGridRequestContextHeaders — cross-language contract fixture', () => {
  it('the fixture actually has cases (guards against a silently-empty/misresolved fixture path)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2)
  })

  for (const testCase of fixture.cases) {
    it(`matches the wire contract: ${testCase.name}`, () => {
      expect(buildGridRequestContextHeaders(testCase.input)).toEqual(testCase.headers)
    })
  }
})

describe('buildGridRequestContextHeaders — omission rules', () => {
  it('omits every header for an empty input (no org/project/scope at all)', () => {
    expect(buildGridRequestContextHeaders({})).toEqual({})
  })

  it('omits X-Grid-Collection-Scope for an empty array, not an empty-array-encoded header', () => {
    const headers = buildGridRequestContextHeaders({ collectionScope: [] })
    expect(headers[GRID_HEADER_NAMES.COLLECTION_SCOPE]).toBeUndefined()
  })

  it('omits X-Grid-Model-Overrides for an empty object, mirroring "use YAML defaults"', () => {
    const headers = buildGridRequestContextHeaders({ modelOverrides: {} })
    expect(headers[GRID_HEADER_NAMES.MODEL_OVERRIDES]).toBeUndefined()
  })

  it('omits X-Grid-Model-Overrides for null/undefined', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        buildGridRequestContextHeaders({ modelOverrides: null }),
        GRID_HEADER_NAMES.MODEL_OVERRIDES,
      ),
    ).toBe(false)
  })

  it('omits X-Grid-Budget for null, but includes it (even a zeroed snapshot) when present', () => {
    expect(buildGridRequestContextHeaders({ budget: null })).toEqual({})
    const headers = buildGridRequestContextHeaders({
      budget: { remainingOrgUsd: 0, remainingUserUsd: 0, remainingProjectUsd: 0 },
    })
    expect(headers[GRID_HEADER_NAMES.BUDGET]).toBeDefined()
  })

  it('omits X-Grid-Disabled-Sources for an empty array', () => {
    expect(buildGridRequestContextHeaders({ disabledSources: [] })).toEqual({})
  })

  it('omits X-Grid-Feature-Memory-Reflection only when undefined, not when explicitly false', () => {
    expect(buildGridRequestContextHeaders({})[GRID_HEADER_NAMES.MEMORY_REFLECTION]).toBeUndefined()
    expect(buildGridRequestContextHeaders({ memoryReflectionEnabled: false })[GRID_HEADER_NAMES.MEMORY_REFLECTION]).toBe(
      'false',
    )
  })

  it('omits string headers (org/user/project id) for empty-string input, matching the server.js falsy guard', () => {
    const headers = buildGridRequestContextHeaders({ organizationId: '', userId: '', projectId: '' })
    expect(headers).toEqual({})
  })
})

describe('bundesland (backlog T3-9 follow-up, 2026-07-16, user-mandated) — envelope-only', () => {
  it('buildGridRequestContextHeaders never emits a header for it (no individual X-Grid-Bundesland header)', () => {
    const headers = buildGridRequestContextHeaders({ bundesland: 'wien' })
    expect(headers).toEqual({})
    expect(Object.keys(headers).some((name) => name.toLowerCase().includes('bundesland'))).toBe(false)
  })

  it('buildGridRequestContextEnvelopePayload includes it when present', () => {
    expect(buildGridRequestContextEnvelopePayload({ bundesland: 'tirol' })).toEqual({ bundesland: 'tirol' })
  })

  it('buildGridRequestContextEnvelopePayload omits it for falsy values', () => {
    expect(buildGridRequestContextEnvelopePayload({ bundesland: null })).toEqual({})
    expect(buildGridRequestContextEnvelopePayload({ bundesland: undefined })).toEqual({})
    expect(buildGridRequestContextEnvelopePayload({ bundesland: '' })).toEqual({})
  })

  it('is appended as the LAST payload key so pre-existing signed cases stay byte-identical', () => {
    const json = JSON.stringify(
      buildGridRequestContextEnvelopePayload({ organizationId: 'org_1', memoryReflectionEnabled: true, bundesland: 'wien' }),
    )
    expect(json).toBe('{"organizationId":"org_1","memoryReflectionEnabled":true,"bundesland":"wien"}')
  })

  it('buildGridRequestContextWireHeaders carries it only on the envelope, not the individual headers', () => {
    const wire = buildGridRequestContextWireHeaders({ organizationId: 'org_1', bundesland: 'wien' }, 'secret')
    const decoded = JSON.parse(Buffer.from(wire[GRID_HEADER_NAMES.REQUEST_CONTEXT], 'base64url').toString('utf8'))
    expect(decoded.bundesland).toBe('wien')
    expect(Object.keys(wire).some((name) => name.toLowerCase().includes('bundesland'))).toBe(false)
  })
})

describe('low-level encoders', () => {
  it('encodeGridJsonHeader matches Buffer.from(JSON.stringify(x)).toString("base64url")', () => {
    const value = { a: 1, b: ['x', 'y'] }
    expect(encodeGridJsonHeader(value)).toBe(Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'))
  })

  it('encodeGridTextHeader matches Buffer.from(x, "utf8").toString("base64url") for multi-line text', () => {
    const text = 'line one\nline two\ncafé'
    expect(encodeGridTextHeader(text)).toBe(Buffer.from(text, 'utf8').toString('base64url'))
  })

  it('encodeGridBudgetHeader is a JSON encoding of the snapshot', () => {
    const snapshot = { remainingOrgUsd: 1.5, remainingUserUsd: null, remainingProjectUsd: 2 }
    expect(encodeGridBudgetHeader(snapshot)).toBe(encodeGridJsonHeader(snapshot))
  })

  it('encodeModelOverridesHeader is a JSON encoding of the overrides map', () => {
    const overrides = { deep_research: 'openrouter/anthropic/claude-3.7-sonnet' }
    expect(encodeModelOverridesHeader(overrides)).toBe(encodeGridJsonHeader(overrides))
  })
})

describe('buildGridRequestContextEnvelope — cross-language contract fixture', () => {
  it('the fixture actually has envelope cases', () => {
    expect(fixture.envelopeCases.length).toBeGreaterThanOrEqual(2)
  })

  for (const testCase of fixture.envelopeCases) {
    it(`matches the signed wire contract: ${testCase.name}`, () => {
      const envelope = buildGridRequestContextEnvelope(testCase.input, testCase.secret)
      expect(envelope.header).toBe(testCase.header)
      expect(envelope.signature).toBe(testCase.signature)
    })

    it(`the envelope payload JSON matches the fixture's documented envelopeJson: ${testCase.name}`, () => {
      const json = JSON.stringify(buildGridRequestContextEnvelopePayload(testCase.input))
      expect(json).toBe(testCase.envelopeJson)
    })
  }
})

describe('buildGridRequestContextEnvelope — omission rules', () => {
  it('an empty input still mints an envelope of "{}" (presence, not omission)', () => {
    const envelope = buildGridRequestContextEnvelope({}, 'secret')
    expect(envelope.header).toBe(Buffer.from('{}', 'utf8').toString('base64url'))
  })

  it('omits every field the individual-header builder also omits', () => {
    const input: GridRequestContextInput = {
      organizationId: '',
      collectionScope: [],
      modelOverrides: {},
      disabledSources: [],
      budget: null,
    }
    expect(buildGridRequestContextEnvelopePayload(input)).toEqual({})
  })
})

describe('buildGridRequestContextEnvelope — signing', () => {
  const input: GridRequestContextInput = { organizationId: 'org_1' }

  it('signature is null when no secret is supplied', () => {
    expect(buildGridRequestContextEnvelope(input, undefined).signature).toBeNull()
    expect(buildGridRequestContextEnvelope(input, null).signature).toBeNull()
    expect(buildGridRequestContextEnvelope(input, '').signature).toBeNull()
  })

  it('signature is a deterministic HMAC-SHA256 hex digest of the payload JSON', () => {
    const envelope = buildGridRequestContextEnvelope(input, 'my-secret')
    const json = JSON.stringify(buildGridRequestContextEnvelopePayload(input))
    expect(envelope.signature).toBe(signGridRequestContextEnvelope(json, 'my-secret'))
    expect(envelope.signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different secrets produce different signatures for the same payload', () => {
    const a = buildGridRequestContextEnvelope(input, 'secret-a')
    const b = buildGridRequestContextEnvelope(input, 'secret-b')
    expect(a.signature).not.toBe(b.signature)
    expect(a.header).toBe(b.header) // unsigned payload identical
  })
})

describe('buildGridRequestContextEnvelopeHeaders', () => {
  it('always sets X-Grid-Request-Context, only sets -Sig when signed', () => {
    const unsigned = buildGridRequestContextEnvelopeHeaders({ organizationId: 'org_1' }, undefined)
    expect(unsigned[GRID_HEADER_NAMES.REQUEST_CONTEXT]).toBeDefined()
    expect(unsigned[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]).toBeUndefined()

    const signed = buildGridRequestContextEnvelopeHeaders({ organizationId: 'org_1' }, 'secret')
    expect(signed[GRID_HEADER_NAMES.REQUEST_CONTEXT]).toBeDefined()
    expect(signed[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]).toBeDefined()
  })
})

describe('buildGridRequestContextWireHeaders', () => {
  it('dual-writes: contains every individual header AND the envelope', () => {
    const input: GridRequestContextInput = {
      organizationId: 'org_1',
      userId: 'user_1',
      memoryReflectionEnabled: true,
    }
    const wire = buildGridRequestContextWireHeaders(input, 'secret')

    expect(wire).toMatchObject(buildGridRequestContextHeaders(input))
    expect(wire[GRID_HEADER_NAMES.REQUEST_CONTEXT]).toBeDefined()
    expect(wire[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Verifying an envelope (ADR-0054)
// ---------------------------------------------------------------------------

describe('verifyGridRequestContextEnvelope', () => {
  const SECRET = 'verify-spec-secret' // pragma: allowlist secret
  const NOW = 1789430400000

  const mint = (input: Parameters<typeof buildGridRequestContextEnvelope>[0]) =>
    buildGridRequestContextEnvelope(input, SECRET)

  const valid = () =>
    mint({
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: 'proj_1',
      conversationId: 's_conv_1',
      issuedAt: NOW,
    })

  it('reads the acting identity out of a well-signed, fresh envelope', () => {
    const { header, signature } = valid()
    expect(verifyGridRequestContextEnvelope(header, signature, SECRET, NOW)).toEqual({
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: 'proj_1',
      conversationId: 's_conv_1',
      issuedAt: NOW,
    })
  })

  it('refuses a tampered signature', () => {
    const { header, signature } = valid()
    const flipped = (signature![0] === '0' ? '1' : '0') + signature!.slice(1)
    expect(verifyGridRequestContextEnvelope(header, flipped, SECRET, NOW)).toBeNull()
  })

  it('refuses an envelope signed with another secret', () => {
    const { header, signature } = valid()
    expect(verifyGridRequestContextEnvelope(header, signature, 'a-different-secret', NOW)).toBeNull()
  })

  it('refuses an edited payload, because the signature covers it', () => {
    const { signature } = valid()
    const tampered = Buffer.from(
      JSON.stringify({ organizationId: 'org_2', userId: 'user_1', issuedAt: NOW }),
      'utf8',
    ).toString('base64url')
    expect(verifyGridRequestContextEnvelope(tampered, signature, SECRET, NOW)).toBeNull()
  })

  it('refuses a replay once the window has passed, in both directions', () => {
    const { header, signature } = valid()
    // `issuedAt` is INSIDE the signed bytes, so a caller cannot refresh it.
    expect(
      verifyGridRequestContextEnvelope(header, signature, SECRET, NOW + GRID_REQUEST_CONTEXT_MAX_AGE_MS + 1),
    ).toBeNull()
    expect(
      verifyGridRequestContextEnvelope(header, signature, SECRET, NOW - GRID_REQUEST_CONTEXT_MAX_AGE_MS - 1),
    ).toBeNull()
  })

  it('accepts an envelope at the edge of the window', () => {
    const { header, signature } = valid()
    expect(
      verifyGridRequestContextEnvelope(header, signature, SECRET, NOW + GRID_REQUEST_CONTEXT_MAX_AGE_MS),
    ).not.toBeNull()
  })

  it('refuses an envelope with no issuedAt — fail-closed, unlike the Python reader', () => {
    // The Python side has accepted envelopes without one since before the field
    // existed and would break every in-flight turn if it stopped. A BFF WRITE
    // route has no such history and no reason to allow an unbounded replay.
    const { header, signature } = mint({ organizationId: 'org_1', userId: 'user_1' })
    expect(verifyGridRequestContextEnvelope(header, signature, SECRET, NOW)).toBeNull()
  })

  it('refuses an envelope that names nobody, however well signed', () => {
    const { header, signature } = mint({ collectionScope: ['oib_knowledge'], issuedAt: NOW })
    expect(verifyGridRequestContextEnvelope(header, signature, SECRET, NOW)).toBeNull()
  })

  it('refuses when no secret is configured, rather than treating that as permission', () => {
    const { header, signature } = valid()
    expect(verifyGridRequestContextEnvelope(header, signature, '', NOW)).toBeNull()
    expect(verifyGridRequestContextEnvelope(header, null, SECRET, NOW)).toBeNull()
    expect(verifyGridRequestContextEnvelope(null, signature, SECRET, NOW)).toBeNull()
  })

  it('refuses a header that is not base64url JSON', () => {
    expect(verifyGridRequestContextEnvelope('not-json', 'deadbeef', SECRET, NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The producer this repo cannot type-check: server.js (ADR-0054)
// ---------------------------------------------------------------------------

/**
 * `server.js` is plain CommonJS and duplicates `buildGridRequestContextEnvelopePayload`
 * with a pinning comment, because it cannot import this module. The fixture pins
 * the two builders' OUTPUT; nothing pinned their SOURCE, and the file's own
 * comment says so ("it cannot catch drift in this file's source automatically
 * since server.js has no test harness in this repo").
 *
 * That gap stopped being theoretical when the envelope became a credential: the
 * WS upgrade is the only producer a chat turn has, so a field it forgets is a
 * field the agent's document route never sees — and the failure is a refusal
 * with no diagnostic on the other side of a language boundary.
 *
 * So this reads the file. It compares the FIELD NAMES and their ORDER, which is
 * what the signature depends on (the payload is signed as `JSON.stringify`d
 * bytes, so key order is part of the contract). It deliberately does not try to
 * evaluate the duplicated function: what drifts is the list, not the arithmetic.
 */
describe('server.js mints the same envelope payload this module does', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8')

  /** The `payload.<field>` assignments of the duplicated builder, in file order. */
  const serverFields = (): string[] => {
    const start = source.indexOf('function buildGridRequestContextEnvelopeHeaders(input)')
    expect(start, 'server.js no longer has the duplicated builder this spec pins').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const json = JSON.stringify(payload)', start))
    return [...body.matchAll(/payload\.([A-Za-z]+)\s*=/g)].map((match) => match[1])
  }

  /** Every field this module's builder can emit, in the order it emits them. */
  const canonicalFields = (): string[] =>
    Object.keys(
      buildGridRequestContextEnvelopePayload({
        organizationId: 'org_1',
        userId: 'user_1',
        projectId: 'proj_1',
        collectionScope: ['oib_knowledge'],
        projectContext: 'context',
        projectMemory: 'memory',
        modelOverrides: { shallow_research: 'm' },
        budget: { remainingOrgUsd: 1, remainingUserUsd: 1, remainingProjectUsd: 1 },
        disabledSources: ['web_search'],
        memoryReflectionEnabled: true,
        bundesland: 'wien',
        conversationId: 's_conv_1',
        issuedAt: 1789430400000,
      }),
    )

  it('carries every field, in the same key order — the signature is over the bytes', () => {
    expect(serverFields()).toEqual(canonicalFields())
  })

  it('signs the conversation and the mint time, which is what makes it a credential', () => {
    // Named on their own so the failure says WHICH property was lost: without
    // `conversationId` the document route cannot tell which chat asked, and
    // without `issuedAt` `verifyGridRequestContextEnvelope` refuses every
    // envelope the WS upgrade mints.
    expect(serverFields()).toContain('conversationId')
    expect(serverFields()).toContain('issuedAt')
  })

  it('passes the conversation the scope route authorized, never the raw query param', () => {
    // `conversationId` reaches the envelope from `result.data`, which is
    // `/api/auth/websocket-scope`'s own render after `authorizeConversationScope`.
    // Signing `parsedUrl.query.conversationId` instead would put a caller-chosen
    // value inside a signature a write route trusts.
    expect(source).toContain('conversationId: result.data?.conversationId')
  })
})
