/**
 * @vitest-environment node
 *
 * `/api/healthz` names the deployed commit.
 *
 * The boot log prints it too, but a pilot report arrives days after that line
 * has rotated out of the pod. This route is the half of ledger item 1 that can
 * still be asked afterwards — over HTTP, from outside, with no shell — so the
 * field is asserted here rather than left to a hand check that nobody repeats.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { GET } from '@/app/api/healthz/route'

const ORIGINAL = process.env.GRID_GIT_SHA

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GRID_GIT_SHA
  else process.env.GRID_GIT_SHA = ORIGINAL
})

/** The route is a `publicApiRoute`, so it takes a Request and nothing else. */
const probe = async (): Promise<Response> =>
  (await GET(new Request('http://localhost:3000/api/healthz'), {
    params: Promise.resolve({}),
  } as never)) as Response

describe('GET /api/healthz', () => {
  it('reports the deployed sha alongside the liveness status', async () => {
    // A real 40-hex commit, so the assertion is on the shape a deployment
    // actually carries.
    process.env.GRID_GIT_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c' // pragma: allowlist secret

    const response = await probe()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      sha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', // pragma: allowlist secret
    })
  })

  it('answers `unknown` for an image nothing stamped, never an empty field', async () => {
    // `sha=` in a health payload reads as a truncation; `unknown` reads as an
    // image that was not built by publish-images.yml, which is the fact.
    delete process.env.GRID_GIT_SHA

    await expect((await probe()).json()).resolves.toMatchObject({ sha: 'unknown' })
  })

  it('stays a dependency-free probe: no store, and still 200 with nothing configured', async () => {
    delete process.env.GRID_GIT_SHA

    const response = await probe()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
