export type AutomationTab = 'jobs' | 'skills'

export function parseAutomationTab(value: string | undefined): AutomationTab {
  return value === 'skills' ? 'skills' : 'jobs'
}
