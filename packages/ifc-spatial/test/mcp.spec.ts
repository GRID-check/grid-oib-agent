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
import { GraphCache } from '../src/cache.js'
import { createTools, type ToolDef } from '../src/mcp/tools.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/haus-mit-raeumen.ifc', import.meta.url))

describe('mcp tools', () => {
  let tools: Map<string, ToolDef>
  let model: string

  const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args)

  beforeAll(async () => {
    tools = new Map(createTools(new GraphCache()).map((t) => [t.name, t]))
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
