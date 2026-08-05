// @vitest-environment node
/**
 * The tenant context, and the leak it is built to avoid (ADR-0041).
 *
 * `AsyncLocalStorage.enterWith` has no scope end: it writes into the current
 * async resource, and Node reuses that resource for the next request on the
 * same keep-alive socket. Reproduced against a plain `node:http` server — one
 * request set a tenant, awaited, and the two requests that followed it on the
 * same socket inherited that tenant. The victim is not the request that sets a
 * tenant; it is a later one that sets NONE, should therefore fail closed, and
 * instead runs as whoever used the socket last.
 *
 * That reproduction is deliberately NOT a test here: it asserts Node's
 * scheduling rather than our code, and it does not fire under the vitest
 * runner, so as a test it would be a flake that proves nothing. What IS tested
 * is the property that makes it moot — every scope comes from `run()`, starts
 * empty, and leaves nothing behind — plus a static check that the route
 * factories actually open one.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  MissingTenantContextError,
  enterTenantContext,
  getTenantContext,
  requireTenantContext,
  runWithTenantSlot,
  withOptionalTenant,
  withPlatformAccess,
  withTenant,
} from './tenant-context'

/**
 * Drive two sequential requests down ONE keep-alive socket and report what each
 * saw before it did anything. `onRequest` runs inside the server handler.
 */
async function overOneSocket(
  onRequest: (path: string) => Promise<void> | void,
  observe: () => string | null,
  paths: string[]
): Promise<Array<{ path: string; seen: string | null }>> {
  const seen: Array<{ path: string; seen: string | null }> = []
  const server = http.createServer(async (req, res) => {
    seen.push({ path: req.url ?? '', seen: observe() })
    await onRequest(req.url ?? '')
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as { port: number }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  try {
    for (const path of paths) {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ port, path, agent }, (res) => {
          res.resume()
          res.on('end', resolve)
        })
        request.on('error', reject)
      })
    }
  } finally {
    agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return seen
}

describe('runWithTenantSlot', () => {
  it('does not leak a tenant to the next request on the same socket', async () => {
    const seen = await overOneSocket(
      async (path) => {
        await runWithTenantSlot(async () => {
          if (path === '/sets-a') {
            enterTenantContext({ organizationId: 'ORG_A', userId: 'u1' })
            // Same shape as the leaking case above, so this is a like-for-like
            // comparison rather than a weaker one.
            await new Promise((resolve) => setTimeout(resolve, 5))
            expect(getTenantContext()).toMatchObject({ organizationId: 'ORG_A' })
          }
        })
      },
      () => {
        const context = getTenantContext()
        return context && context.kind === 'tenant' ? context.organizationId : null
      },
      ['/sets-a', '/sets-nothing', '/sets-nothing']
    )

    expect(seen.map((entry) => entry.seen)).toEqual([null, null, null])
  })

  it('starts empty, so a handler that sets nothing fails closed', async () => {
    await runWithTenantSlot(async () => {
      expect(getTenantContext()).toBeUndefined()
      expect(() => requireTenantContext()).toThrow(MissingTenantContextError)
    })
  })

  it('leaves no context behind after it returns', async () => {
    await runWithTenantSlot(async () => {
      enterTenantContext({ organizationId: 'ORG_A', userId: 'u1' })
    })
    expect(getTenantContext()).toBeUndefined()
  })
})

describe('enterTenantContext', () => {
  it('fills the slot the request opened', async () => {
    await runWithTenantSlot(async () => {
      enterTenantContext({ organizationId: 'ORG_A', userId: 'u1' })
      expect(getTenantContext()).toEqual({
        kind: 'tenant',
        organizationId: 'ORG_A',
        userId: 'u1',
      })
    })
  })

  it('publishes nothing for a session with no active organization', async () => {
    await runWithTenantSlot(async () => {
      enterTenantContext({ organizationId: null, userId: 'u1' })
      expect(getTenantContext()).toBeUndefined()
    })
  })

  it('replaces an inherited slot wholesale rather than reusing it', async () => {
    // The server-component path has no factory to open a slot, so it falls back
    // to enterWith. A later request must overwrite that value, never read it.
    await runWithTenantSlot(async () => {
      enterTenantContext({ organizationId: 'ORG_A', userId: 'u1' })
      enterTenantContext({ organizationId: 'ORG_B', userId: 'u2' })
      expect(getTenantContext()).toMatchObject({ organizationId: 'ORG_B', userId: 'u2' })
    })
  })
})

describe('explicit scopes', () => {
  afterEach(() => {
    expect(getTenantContext()).toBeUndefined()
  })

  it('withTenant scopes to one organization and restores after', async () => {
    const inside = await withTenant({ organizationId: 'ORG_A', userId: 'u1' }, () =>
      getTenantContext()
    )
    expect(inside).toEqual({ kind: 'tenant', organizationId: 'ORG_A', userId: 'u1' })
  })

  it('withTenant awaits a lazy result inside the scope', async () => {
    // A drizzle query builder is lazy; returning one unexecuted would run it
    // after the scope closed. `withTenant` awaits for exactly this reason.
    const lazy = { then: (resolve: (value: unknown) => void) => resolve(getTenantContext()) }
    const observed = await withTenant({ organizationId: 'ORG_A' }, () => lazy)
    expect(observed).toMatchObject({ organizationId: 'ORG_A' })
  })

  it('withPlatformAccess carries its reason', async () => {
    const inside = await withPlatformAccess('nightly sweep', () => getTenantContext())
    expect(inside).toEqual({ kind: 'platform', reason: 'nightly sweep' })
  })

  it('nests: an inner scope wins and the outer one is restored', async () => {
    await withTenant({ organizationId: 'ORG_A' }, async () => {
      await withPlatformAccess('inner', () => {
        expect(getTenantContext()).toMatchObject({ kind: 'platform' })
      })
      expect(getTenantContext()).toMatchObject({ kind: 'tenant', organizationId: 'ORG_A' })
    })
  })

  it('withOptionalTenant picks the tenant when there is one', async () => {
    const inside = await withOptionalTenant('ORG_A', 'unused', () => getTenantContext())
    expect(inside).toMatchObject({ kind: 'tenant', organizationId: 'ORG_A' })
  })

  it('withOptionalTenant falls back to an audited platform scope when there is not', async () => {
    for (const absent of [null, undefined, '']) {
      const inside = await withOptionalTenant(absent, 'org-less telemetry', () =>
        getTenantContext()
      )
      expect(inside).toEqual({ kind: 'platform', reason: 'org-less telemetry' })
    }
  })

  it('restores the previous scope even when the callback throws', async () => {
    await expect(
      withTenant({ organizationId: 'ORG_A' }, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })

  it('keeps concurrent scopes independent', async () => {
    const observe = async (org: string) =>
      withTenant({ organizationId: org }, async () => {
        await new Promise((resolve) => setTimeout(resolve, org === 'ORG_A' ? 20 : 1))
        const context = getTenantContext()
        return context && context.kind === 'tenant' ? context.organizationId : null
      })

    expect(await Promise.all([observe('ORG_A'), observe('ORG_B')])).toEqual(['ORG_A', 'ORG_B'])
  })
})

/**
 * The behavioural tests above prove the scope is bounded. This proves the
 * bounded scope is actually USED — the part a refactor could quietly drop, and
 * whose absence fails open rather than loudly (ADR-0041).
 */
describe('route factories open a request-scoped slot', () => {
  const FACTORIES: Array<{ file: string; factories: string[] }> = [
    { file: 'src/lib/api/handler.ts', factories: ['apiRoute', 'internalApiRoute', 'publicApiRoute'] },
    { file: 'src/lib/api/platform-handler.ts', factories: ['platformApiRoute'] },
  ]

  it.each(FACTORIES)('$file wraps every handler in runWithTenantSlot', ({ file, factories }) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')

    for (const factory of factories) {
      const start = source.indexOf(`export function ${factory}`)
      expect(start, `${factory} not found in ${file}`).toBeGreaterThan(-1)
      const next = FACTORIES.flatMap((entry) => entry.factories)
        .map((name) => source.indexOf(`export function ${name}`, start + 1))
        .filter((index) => index > start)
      const body = source.slice(start, next.length ? Math.min(...next) : undefined)

      expect(
        body,
        `${factory} must wrap its handler in runWithTenantSlot, or a request can ` +
          `inherit the previous request's tenant off a keep-alive socket.`
      ).toContain('runWithTenantSlot')
    }
  })

  it('nothing calls the unbounded enterWith except the documented session fallback', () => {
    const context = readFileSync(join(process.cwd(), 'src/lib/db/tenant-context.ts'), 'utf8')
    // Exactly one: the server-component path, which no factory wraps.
    expect(context.match(/storage\.enterWith\(/g) ?? []).toHaveLength(1)
  })
})
