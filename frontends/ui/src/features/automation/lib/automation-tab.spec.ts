import { describe, expect, test } from 'vitest'
import { AUTOMATION_TABS, parseAutomationTab, tabForDeepLink } from './automation-tab'

describe('parseAutomationTab', () => {
  test('Tasks is the default for anything that is not a tab', () => {
    expect(parseAutomationTab(undefined)).toBe('tasks')
    expect(parseAutomationTab('nonsense')).toBe('tasks')
  })

  test('names the two tabs', () => {
    expect(parseAutomationTab('tasks')).toBe('tasks')
    expect(parseAutomationTab('skills')).toBe('skills')
  })

  test('the retired tab ids still answer', () => {
    // A bookmark is not an error. `jobs` was the Jobs tab and `schedule` the
    // Zeitplan tab; both meant the standing arrangements, which are Tasks now.
    expect(parseAutomationTab('jobs')).toBe('tasks')
    expect(parseAutomationTab('schedule')).toBe('tasks')
  })

  test('the vocabulary holds exactly the two tabs', () => {
    expect([...AUTOMATION_TABS].sort()).toEqual(['skills', 'tasks'])
  })
})

describe('tabForDeepLink', () => {
  test('a URL carrying no drawer picks no tab', () => {
    expect(tabForDeepLink(new URLSearchParams())).toBeNull()
    expect(tabForDeepLink(new URLSearchParams('view=timetable'))).toBeNull()
  })

  test('both task drawers belong to Tasks', () => {
    expect(tabForDeepLink(new URLSearchParams('task=run-1'))).toBe('tasks')
    expect(tabForDeepLink(new URLSearchParams('schedule=def-1'))).toBe('tasks')
  })

  test('a skill drawer belongs to Skills', () => {
    // The regression this guards: without the `skill` branch the link landed
    // on Tasks, where the toolbox that owns that drawer is not mounted, so the
    // drawer never opened and the URL looked like it had been ignored.
    expect(tabForDeepLink(new URLSearchParams('skill=skill-1'))).toBe('skills')
  })

  test('a task drawer wins over a skill one, so the answer is a single tab', () => {
    expect(tabForDeepLink(new URLSearchParams('skill=skill-1&task=run-1'))).toBe('tasks')
  })
})
