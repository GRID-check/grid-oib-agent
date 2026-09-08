/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import { buildScopeLevels, projectLevel } from './scope-tree-model'

const ids = (input: Parameters<typeof buildScopeLevels>[0]) =>
  buildScopeLevels(input).map((level) => level.id)

describe('level order', () => {
  it('is the fixed authority order, on both surfaces', () => {
    const order = ['base', 'archiv', 'register', 'project', 'session']
    expect(ids({ scope: 'workspace' })).toEqual(order)
    expect(ids({ scope: 'project', projectName: 'Seestadt Nord' })).toEqual(order)
  })

  it('renders the register OUTSIDE the Büro too — as unavailable, with a reason', () => {
    const register = buildScopeLevels({ scope: 'project', projectName: 'X' }).find(
      (level) => level.id === 'register'
    )
    expect(register?.state).toBe('unavailable')
    expect(register?.reason?.key).toBe('workspace.tree.registerOutsideWorkspace')
  })
})

describe('the four states', () => {
  it('base and archive are always on when no preset narrowed them', () => {
    const levels = buildScopeLevels({ scope: 'workspace' })
    expect(levels.find((l) => l.id === 'base')?.state).toBe('always')
    expect(levels.find((l) => l.id === 'archiv')?.state).toBe('always')
  })

  it('a preset that excludes a level states WHERE it was turned off', () => {
    const levels = buildScopeLevels({
      scope: 'workspace',
      preset: { label: 'Büroarchiv', excludes: ['project'] },
      mounted: [{ projectId: 'p', projectName: 'Seestadt Nord' }],
    })
    const project = projectLevel(levels)
    expect(project?.state).toBe('off')
    expect(project?.reason).toEqual({
      key: 'workspace.tree.offByPreset',
      values: { preset: 'Büroarchiv' },
    })
  })

  it('nothing mounted is `off` with NO preset reason — a different fact from an exclusion', () => {
    const project = projectLevel(buildScopeLevels({ scope: 'workspace' }))
    expect(project?.state).toBe('off')
    expect(project?.reason).toBeUndefined()
  })

  it('the conversation level is unavailable until a file is attached, and says so', () => {
    const empty = buildScopeLevels({ scope: 'workspace' }).find((l) => l.id === 'session')
    expect(empty?.state).toBe('unavailable')
    expect(empty?.reason?.key).toBe('workspace.tree.sessionEmpty')

    const withFile = buildScopeLevels({ scope: 'workspace', sessionAttachmentCount: 2 }).find(
      (l) => l.id === 'session'
    )
    expect(withFile?.state).toBe('always')
  })
})

describe('the project level', () => {
  it('in the Büro it carries the mounted list and the add affordance', () => {
    const project = projectLevel(
      buildScopeLevels({
        scope: 'workspace',
        mounted: [
          { projectId: 'a', projectName: 'Seestadt Nord' },
          { projectId: 'b', projectName: 'Rosenhügel', mountedBy: 'agent' },
        ],
      })
    )
    expect(project?.state).toBe('on')
    expect(project?.mounted?.map((m) => m.projectName)).toEqual(['Seestadt Nord', 'Rosenhügel'])
    expect(project?.canMount).toBe(true)
    expect(project?.lockedProjectName).toBeUndefined()
  })

  it('at the cap the add affordance is withheld, the list is not', () => {
    const project = projectLevel(
      buildScopeLevels({
        scope: 'workspace',
        mounted: [{ projectId: 'a', projectName: 'A' }],
        canMount: false,
      })
    )
    expect(project?.canMount).toBe(false)
    expect(project?.mounted).toHaveLength(1)
  })

  it('in a project chat it is one locked project — no list, no add', () => {
    const project = projectLevel(
      buildScopeLevels({ scope: 'project', projectName: 'Seestadt Nord' })
    )
    expect(project?.state).toBe('always')
    expect(project?.lockedProjectName).toBe('Seestadt Nord')
    expect(project?.mounted).toBeUndefined()
    expect(project?.canMount).toBeUndefined()
  })
})

describe('provenance', () => {
  it('takes no new hue: register, project and conversation share the project family', () => {
    const levels = buildScopeLevels({ scope: 'workspace' })
    const signal = (id: string) => levels.find((l) => l.id === id)?.signal
    expect(signal('base')).toBe('law')
    expect(signal('archiv')).toBe('office')
    expect(signal('register')).toBe('project')
    expect(signal('project')).toBe('project')
    expect(signal('session')).toBe('project')
  })
})
