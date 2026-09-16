import { describe, expect, test } from 'vitest'
import { parseTasksView, TASKS_VIEWS } from './tasks-view'

describe('parseTasksView', () => {
  test('the list is the default for anything that is not a view', () => {
    expect(parseTasksView(undefined)).toBe('list')
    expect(parseTasksView('nonsense')).toBe('list')
  })

  test('names the two views', () => {
    expect(parseTasksView('list')).toBe('list')
    expect(parseTasksView('timetable')).toBe('timetable')
  })

  test('the vocabulary holds exactly the two views', () => {
    expect([...TASKS_VIEWS].sort()).toEqual(['list', 'timetable'])
  })
})
