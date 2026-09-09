/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import { buildScopeLevels, memoryLevel, projectLevel } from './scope-tree-model'

const ids = (input: Parameters<typeof buildScopeLevels>[0]) =>
  buildScopeLevels(input).map((level) => level.id)

describe('level order', () => {
  it('is the fixed authority order, on both surfaces', () => {
    // `memory` sits after `project` and before `session` (ADR-0055): narrower
    // than the project's documents, wider than one conversation's files.
    const order = ['base', 'archiv', 'register', 'project', 'memory', 'session']
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


/**
 * The level read on EVERY turn (ADR-0055). Its properties are the ones the
 * design turns on: it cannot be switched off from here, it states what the turn
 * saw of it, and outside a project with nothing to read it is an honest closed
 * door rather than an absent row.
 */
describe('the memory level', () => {
  it('is `always` on both surfaces — no preset reaches it', () => {
    for (const preset of [null, { label: 'Büroarchiv', excludes: ['project'] as const }]) {
      expect(
        memoryLevel(buildScopeLevels({ scope: 'workspace', preset: preset ?? null }))?.state
      ).toBe('always')
      expect(
        memoryLevel(
          buildScopeLevels({ scope: 'project', projectName: 'X', preset: preset ?? null })
        )?.state
      ).toBe('always')
    }
  })

  it('carries the counts the turn reported, omission included', () => {
    const level = memoryLevel(
      buildScopeLevels({
        scope: 'project',
        projectName: 'Seestadt Nord',
        memory: { carried: 3, total: 47, omitted: 44 },
      })
    )
    expect(level?.memory).toEqual({ carried: 3, total: 47, omitted: 44 })
  })

  it('states no counts before a turn has reported any — zero would be invented', () => {
    expect(memoryLevel(buildScopeLevels({ scope: 'project', projectName: 'X' }))?.memory)
      .toBeUndefined()
  })

  it('paints in --source-auto, never a corpus family', () => {
    // A note is not evidence and must not be paintable as any tier of it.
    expect(memoryLevel(buildScopeLevels({ scope: 'workspace' }))?.signal).toBe('auto')
  })

  it('is a closed door in the Büro with no organization memory, WITH a reason', () => {
    const level = memoryLevel(
      buildScopeLevels({ scope: 'workspace', hasOrganizationMemory: false })
    )
    expect(level?.state).toBe('unavailable')
    expect(level?.reason?.key).toBe('workspace.tree.memoryNoOrganization')
  })

  it('stays `always` in a PROJECT chat even with no organization memory', () => {
    // The flag is about organization notes, which are the only ones in scope
    // outside a project. Inside one, the project's own memory is always read.
    expect(
      memoryLevel(
        buildScopeLevels({ scope: 'project', projectName: 'X', hasOrganizationMemory: false })
      )?.state
    ).toBe('always')
  })
})
