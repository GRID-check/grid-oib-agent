/**
 * @vitest-environment node
 */

/**
 * `open_project` returns a JSON line and then German prose for the model. What
 * these tests hold is the split: the line is read, the prose never is, and a
 * payload this build cannot phrase produces silence rather than a raw token in
 * the transcript.
 */

import { describe, expect, it } from 'vitest'
import { isOpenProjectStepName, parseMountEvent } from './mount-events'

const mounted = (extra = '') =>
  '{"event":"mount","status":"mounted","projectId":"p1","projectName":"Seestadt Nord","mountedBy":"agent"}\n\n' +
  'Seestadt Nord ist jetzt eingeblendet: du kannst seine Dokumente ab sofort durchsuchen.' +
  extra

describe('the step name', () => {
  it('matches the tool however NAT dressed it', () => {
    expect(isOpenProjectStepName('workspace_open_project')).toBe(true)
    expect(isOpenProjectStepName('tool: workspace_open_project')).toBe(true)
    expect(isOpenProjectStepName('  WORKSPACE_OPEN_PROJECT ')).toBe(true)
  })

  it('does not match the other workspace tool', () => {
    expect(isOpenProjectStepName('workspace_find_projects')).toBe(false)
  })
})

describe('a mount', () => {
  it('reads the first line and leaves the prose alone', () => {
    expect(parseMountEvent(mounted())).toEqual({
      type: 'mount',
      status: 'mounted',
      projectId: 'p1',
      projectName: 'Seestadt Nord',
      mountedBy: 'agent',
    })
  })

  it('survives NAT’s html.escape, which JSON.parse would not have noticed', () => {
    const escaped =
      '{"event":"mount","status":"mounted","projectId":"p1","projectName":"Brand &amp; Rauch","mountedBy":"agent"}\n\nProse.'
    expect(parseMountEvent(escaped)).toMatchObject({ projectName: 'Brand & Rauch' })
  })

  it('falls back to the id rather than putting a nameless chip in view', () => {
    const nameless = '{"event":"mount","status":"mounted","projectId":"p1"}\n\nProse.'
    expect(parseMountEvent(nameless)).toMatchObject({ projectName: 'p1' })
  })

  it('is not a mount without a project id — there would be nothing to widen to', () => {
    expect(parseMountEvent('{"event":"mount","status":"mounted"}\n\nProse.')).toBeNull()
  })
})

describe('a refusal', () => {
  it('carries the cap, because the offer behind it needs the number', () => {
    const body =
      '{"event":"mount","status":"refused","code":"cap","cap":5,"projectId":"p9"}\n\nDiese Unterhaltung hat bereits …'
    expect(parseMountEvent(body)).toEqual({
      type: 'mount',
      status: 'refused',
      code: 'cap',
      projectId: 'p9',
      cap: 5,
    })
  })

  it.each(['no_access', 'not_found', 'unavailable'])('keeps the %s code', (code) => {
    const body = `{"event":"mount","status":"refused","code":"${code}","cap":null,"projectId":null}\n\nProse.`
    expect(parseMountEvent(body)).toMatchObject({ code, projectId: null })
  })

  it('degrades an unknown code to the sentence that is true of every refusal', () => {
    const body = '{"event":"mount","status":"refused","code":"quota_exceeded"}\n\nProse.'
    expect(parseMountEvent(body)).toMatchObject({ code: 'unavailable' })
  })
})

describe('silence', () => {
  it.each([
    ['prose with no event line', 'Seestadt Nord ist jetzt eingeblendet.'],
    ['a truncated line', '{"event":"mount","status":"mou'],
    ['another tool’s payload', '{"event":"remember","status":"saved"}'],
    ['an unknown status', '{"event":"mount","status":"pending","projectId":"p"}'],
    ['nothing at all', ''],
    ['undefined', undefined],
  ])('says nothing for %s', (_label, payload) => {
    expect(parseMountEvent(payload as string | undefined)).toBeNull()
  })
})
