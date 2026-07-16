import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  buildGridRequestContextHeaders,
  encodeGridBudgetHeader,
  encodeGridJsonHeader,
  encodeGridTextHeader,
  encodeModelOverridesHeader,
  GRID_HEADER_NAMES,
  type GridRequestContextInput,
} from './request-context'
import { encodeModelOverridesHeader as reExportedEncodeModelOverridesHeader } from './model-config/header-encoding'

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

interface GridRequestContextFixture {
  cases: GridRequestContextFixtureCase[]
}

const fixturePath = fileURLToPath(new URL('../../tests/fixtures/grid_request_context.json', import.meta.url))
const fixture: GridRequestContextFixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

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

describe('model-config/header-encoding re-export', () => {
  it('re-exports the exact same function as @/lib/request-context (no drift between the two import paths)', () => {
    expect(reExportedEncodeModelOverridesHeader).toBe(encodeModelOverridesHeader)
  })
})
