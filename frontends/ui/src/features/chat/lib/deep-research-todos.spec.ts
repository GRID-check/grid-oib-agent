/**
 * @vitest-environment node
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { normalizeDeepResearchTodos } from './deep-research-todos'

describe('normalizeDeepResearchTodos', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('keeps known statuses as-is', () => {
    const todos = normalizeDeepResearchTodos([
      { content: 'Plan the research', status: 'pending' },
      { content: 'Search sources', status: 'in_progress' },
      { content: 'Read OIB 2', status: 'completed' },
    ])

    expect(todos.map((t) => t.status)).toEqual(['pending', 'in_progress', 'completed'])
  })

  test('maps stopped and cancelled to stopped', () => {
    const todos = normalizeDeepResearchTodos([
      { content: 'A', status: 'stopped' },
      { content: 'B', status: 'cancelled' },
    ])

    expect(todos.map((t) => t.status)).toEqual(['stopped', 'stopped'])
  })

  test('falls back to pending for an unknown status and warns in dev', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const todos = normalizeDeepResearchTodos([{ content: 'A', status: 'blocked' }])

    expect(todos[0].status).toBe('pending')
    // Vitest runs with NODE_ENV=test (non-production) — the dev warning fires.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"blocked"'))
  })

  test('does not warn for known statuses', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    normalizeDeepResearchTodos([
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'cancelled' },
    ])

    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('derives stable ids from index and content', () => {
    const todos = normalizeDeepResearchTodos([
      { content: 'Check Fire Safety Rules', status: 'pending' },
    ])

    expect(todos[0].id).toBe('todo-0-check-fire-safety-ru')
    expect(todos[0].content).toBe('Check Fire Safety Rules')
  })
})
