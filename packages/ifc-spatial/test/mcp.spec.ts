/**
 * The tool surface, end to end.
 *
 * Exercised through `createTools` rather than through a transport: the handlers
 * are where the argument checking and the German wording live, and a test that
 * stood a JSON-RPC client up in front of them would assert the SDK works rather
 * than that we do. `server.spec` territory is one `createSpatialServer()` call,
 * which is checked here only for "does it register what it says it does".
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { SpatialCache } from '../src/model.js'
import { assertFetchable, createTools, type ToolDef } from '../src/mcp/tools.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/haus-mit-raeumen.ifc', import.meta.url))

describe('mcp tools', () => {
  let tools: Map<string, ToolDef>
  let model: string

  const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args)

  beforeAll(async () => {
    tools = new Map(createTools(new SpatialCache()).map((t) => [t.name, t]))
    const opened = (await call('open_model', { path: FIXTURE })) as { model: string }
    model = opened.model
  })

  it('opens a model by path and answers with a content-addressed handle', () => {
    expect(model).toMatch(/^[0-9a-f]{12}$/)
  })

  it('refuses to work before a model is opened, and says how', async () => {
    await expect(call('briefing', { model: 'deadbeefdead' })).rejects.toThrow(/open_model/)
  })

  it('accepts an abbreviated handle and rejects an ambiguous one', async () => {
    await expect(call('briefing', { model: model.slice(0, 8) })).resolves.toBeTruthy()
    await expect(call('briefing', { model: 'abc' })).rejects.toThrow(/nicht geöffnet/)
  })

  it('finds elements and hands back the GlobalIds the other tools take', async () => {
    const found = (await call('find_elements', { model, ifcType: 'IfcWindow' })) as {
      elements: Array<{ globalId: string }>
      total: number
    }
    expect(found.total).toBe(1)
    expect(found.elements[0]!.globalId).toBeTruthy()
  })

  it('does not let an empty result read as a statement about the building', async () => {
    const none = (await call('find_elements', { model, ifcType: 'IfcStair' })) as { total: number; hint?: string }
    expect(none.total).toBe(0)
    expect(none.hint).toMatch(/Briefing/)
  })

  it('resolves the window to its wall through the relations tool', async () => {
    const window = (await call('find_elements', { model, ifcType: 'IfcWindow' })) as {
      elements: Array<{ globalId: string }>
    }
    const answer = (await call('relations', {
      model,
      globalId: window.elements[0]!.globalId,
      relation: 'hostedIn',
    })) as { value: Array<{ name: string }>; provenance: string; decidable: boolean; method: string }

    expect(answer.decidable).toBe(true)
    expect(answer.provenance).toBe('computed')
    expect(answer.value).toHaveLength(1)
    expect(answer.value[0]!.name).toBe('Aussenwand Sued')
  })

  it('tells an agent which relations are worth asking about this element', async () => {
    const window = (await call('find_elements', { model, ifcType: 'IfcWindow' })) as {
      elements: Array<{ globalId: string }>
    }
    const detail = (await call('element', { model, globalId: window.elements[0]!.globalId })) as {
      available: string[]
    }
    expect(detail.available).toContain('hostedIn')
    expect(detail.available).toContain('opensTo')
    expect(detail.available).not.toContain('bounds')
  })

  it('turns an unknown GlobalId into an error, not into a finding', async () => {
    await expect(call('relations', { model, globalId: 'NichtImModell000000000', relation: 'hostedIn' })).rejects.toThrow(
      /find_elements/
    )
  })

  it('rejects a relation it does not have, naming the ones it does', async () => {
    await expect(call('relations', { model, globalId: 'x', relation: 'nebenan' })).rejects.toThrow(/hostedIn/)
  })

  it('carries the briefing on open, so the first turn already knows the vocabulary', async () => {
    const opened = (await call('open_model', { path: FIXTURE })) as { briefing: string }
    expect(opened.briefing).toMatch(/GESCHOSSE/)
    expect(opened.briefing).toMatch(/Erdgeschoss|EG/)
  })

  it('names a source when given none', async () => {
    await expect(call('open_model', {})).rejects.toThrow(/path, url oder base64/)
  })
})

/**
 * The handle table is bounded, and bounded by the cache's own number.
 *
 * `createTools` keeps its own `Map` of opened models so a short hash can be
 * resolved back to one. That map is a SECOND set of strong references: while it
 * was unbounded, evicting a model from `SpatialCache` released nothing, because
 * the handle table still named it. Each entry carries a `GeometryIndex` holding
 * up to `GeometryOptions.maxRetainedTriangles` triangles — 2 000 000 by
 * default, roughly 150 MB of float64 — so a long-running server accumulated
 * every building it had ever been asked about and the cache's `maxEntries` was
 * decoration.
 */
describe('open models are bounded', () => {
  const FIXTURES = ['haus-mit-raeumen.ifc', 'strasse-ifc4x3.ifc', 'einheiten-fuss.ifc'].map((name) =>
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  )

  it('evicts the oldest handle once the cache lid is reached, and says how to recover', async () => {
    // Two, so three distinct fixtures are one more than the lid. The number is
    // read back off the cache rather than repeated here: the point of the fix
    // is that there is exactly one bound, not two that agree today.
    const cache = new SpatialCache({ maxEntries: 2 })
    const tools = new Map(createTools(cache).map((t) => [t.name, t]))
    const open = async (path: string): Promise<string> =>
      ((await tools.get('open_model')!.handler({ path })) as { model: string }).model

    const first = await open(FIXTURES[0]!)
    const second = await open(FIXTURES[1]!)
    const third = await open(FIXTURES[2]!)

    // The two most recent still answer; the oldest is gone.
    await expect(tools.get('briefing')!.handler({ model: third })).resolves.toBeTruthy()
    await expect(tools.get('briefing')!.handler({ model: second })).resolves.toBeTruthy()
    await expect(tools.get('briefing')!.handler({ model: first })).rejects.toThrow(/erneut\) öffnen/)
    // The refusal has to be actionable: an agent told only "unknown handle"
    // about a model it opened three turns ago concludes it invented the handle.
    await expect(tools.get('briefing')!.handler({ model: first })).rejects.toThrow(/höchstens 2 Modelle/)
  })

  it('evicts by use and not by open order, so the model under discussion survives', async () => {
    const cache = new SpatialCache({ maxEntries: 2 })
    const tools = new Map(createTools(cache).map((t) => [t.name, t]))
    const open = async (path: string): Promise<string> =>
      ((await tools.get('open_model')!.handler({ path })) as { model: string }).model

    const first = await open(FIXTURES[0]!)
    const second = await open(FIXTURES[1]!)
    // Touching the oldest makes it the newest. Without that, eviction is
    // insertion-ordered and the building an agent has asked about for twenty
    // turns is the first one dropped.
    await tools.get('briefing')!.handler({ model: first })
    const third = await open(FIXTURES[2]!)

    await expect(tools.get('briefing')!.handler({ model: first })).resolves.toBeTruthy()
    await expect(tools.get('briefing')!.handler({ model: third })).resolves.toBeTruthy()
    await expect(tools.get('briefing')!.handler({ model: second })).rejects.toThrow(/nicht geöffnet/)
  })
})

/**
 * `url` is a destination chosen by the model, so `open_model` is a server-side
 * request an agent controls. These are the refusals that keep it from being an
 * SSRF primitive — the request itself is the exposure, whether or not anything
 * is returned.
 */
describe('open_model refuses a url it should not fetch', () => {
  const tools = new Map(createTools(new SpatialCache()).map((t) => [t.name, t]))
  const open = (url: string): Promise<unknown> => tools.get('open_model')!.handler({ url })

  it('allows only http and https', async () => {
    await expect(open('file:///etc/passwd')).rejects.toThrow(/Schema/)
    await expect(open('data:text/plain;base64,SVND')).rejects.toThrow(/Schema/)
    await expect(open('ftp://example.invalid/haus.ifc')).rejects.toThrow(/Schema/)
  })

  it('refuses loopback and the cloud metadata address', async () => {
    // 169.254.169.254 is the one that matters: on AWS, GCE and Azure alike it
    // answers with instance credentials to anything that can reach it.
    await expect(open('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://127.0.0.1:8080/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://localhost:8080/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://[::1]:8080/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://[::ffff:127.0.0.1]/haus.ifc')).rejects.toThrow(/interne Adresse/)
  })

  it('refuses the private ranges a server can usually reach', async () => {
    await expect(open('http://10.0.0.5/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://192.168.1.5/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://172.16.0.5/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://172.31.255.1/haus.ifc')).rejects.toThrow(/interne Adresse/)
    await expect(open('http://[fd00::1]/haus.ifc')).rejects.toThrow(/interne Adresse/)
  })

  // Checked against the guard rather than through the handler: a URL that PASSES
  // is a URL the handler would then dial, and a test that waits out
  // `FETCH_TIMEOUT_MS` against an unroutable address is a two-minute test.
  it('does not refuse the public ranges next to the private ones', () => {
    // The edges of the 172.16/12 block, which a looser `^172\.` would swallow
    // whole along with most of a /8 that is ordinary public space, and of
    // 192.168/16 and 10/8.
    for (const host of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '193.168.1.1', '100.63.0.1', '100.128.0.1']) {
      expect(assertFetchable(`https://${host}/haus.ifc`).hostname).toBe(host)
    }
    expect(assertFetchable('https://example.com/haus.ifc').protocol).toBe('https:')
  })

  it('names the argument rather than the parser when the url is not one', async () => {
    await expect(open('nicht mal eine url')).rejects.toThrow(/keine gültige URL/)
  })
})
