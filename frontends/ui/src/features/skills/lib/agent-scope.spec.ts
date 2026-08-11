/**
 * `grid-agents` is the ONLY thing that decides which agents see a skill, so the
 * two directions of this module have to agree with each other and with both
 * resolvers. The cases below are the ones where a plausible implementation is
 * wrong in a way nothing else would catch.
 */

import { describe, expect, it } from 'vitest'
import { agentScopeLabelKey, formatAgentScope, parseAgentScope } from './agent-scope'

describe('parseAgentScope', () => {
  it('treats an absent key as every agent', () => {
    expect(parseAgentScope(undefined).selected).toEqual([
      'shallow_researcher',
      'deep_researcher',
    ])
    expect(parseAgentScope('').selected).toEqual(['shallow_researcher', 'deep_researcher'])
  })

  it('reads a restriction, tolerating whitespace', () => {
    expect(parseAgentScope(' deep_researcher , ').selected).toEqual(['deep_researcher'])
  })

  it('treats an all-unknown list as every agent, and keeps the unknown names', () => {
    // Both resolvers log and ignore a name that is not an agent, so a list of
    // only typos behaves as if the key were absent. The UI has to show the same
    // thing it will do — and must not quietly delete what the author wrote.
    const scope = parseAgentScope('voice-ana, shallow_reseacher')
    expect(scope.selected).toEqual(['shallow_researcher', 'deep_researcher'])
    expect(scope.unknown).toEqual(['voice-ana', 'shallow_reseacher'])
  })
})

describe('formatAgentScope', () => {
  it('writes nothing when every agent is selected — the default is the absent key', () => {
    expect(
      formatAgentScope({ selected: ['shallow_researcher', 'deep_researcher'], unknown: [] }),
    ).toBe('')
  })

  it('writes the restriction when one agent is deselected', () => {
    expect(formatAgentScope({ selected: ['deep_researcher'], unknown: [] })).toBe('deep_researcher')
  })

  it('carries unknown names through a save it did not change', () => {
    expect(
      formatAgentScope({
        selected: ['shallow_researcher', 'deep_researcher'],
        unknown: ['voice-ana'],
      }),
    ).toBe('voice-ana')
  })

  it('round-trips a restriction', () => {
    for (const raw of ['deep_researcher', 'shallow_researcher']) {
      expect(formatAgentScope(parseAgentScope(raw))).toBe(raw)
    }
  })
})

describe('agentScopeLabelKey', () => {
  it('is null for the default, so a badge appears only where there is a scope', () => {
    expect(agentScopeLabelKey(undefined)).toBeNull()
    expect(agentScopeLabelKey('shallow_researcher,deep_researcher')).toBeNull()
    expect(agentScopeLabelKey('voice-ana')).toBeNull()
  })

  it('names the surviving agent', () => {
    expect(agentScopeLabelKey('shallow_researcher')).toBe('chatOnly')
    expect(agentScopeLabelKey('deep_researcher')).toBe('deepOnly')
    // An unknown name alongside a real one does not change the restriction.
    expect(agentScopeLabelKey('deep_researcher,voice-ana')).toBe('deepOnly')
  })
})
