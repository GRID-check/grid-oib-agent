import { render, screen } from '@/test-utils'
import { describe, expect, test } from 'vitest'

import { makeProject } from '@/test-utils/db-fixtures'
import { ProjectListRow } from './project-list-row'

const renderRow = (props: Partial<Parameters<typeof ProjectListRow>[0]> = {}) =>
  render(
    <ul>
      <ProjectListRow project={makeProject({ id: 'p1', name: 'Wohnbau Seestadt' })} {...props} />
    </ul>,
  )

describe('ProjectListRow', () => {
  test('opens the project in Chat and keeps settings as its own link', () => {
    renderRow()

    expect(screen.getByRole('link', { name: 'Open Wohnbau Seestadt' })).toHaveAttribute(
      'href',
      '/app/projects/p1/chat',
    )
    expect(screen.getByRole('link', { name: 'Open settings for Wohnbau Seestadt' })).toHaveAttribute(
      'href',
      '/app/projects/p1/settings',
    )
  })

  test('indexes the row with the project initials', () => {
    renderRow()
    expect(screen.getByText('WS')).toBeInTheDocument()
  })

  test('labels the timestamp as the viewer’s own only when it is', () => {
    const { unmount } = renderRow({ activityAt: '2026-08-05T09:00:00Z' })
    expect(screen.getByTitle(/^You were last here:/)).toBeInTheDocument()
    unmount()

    renderRow()
    expect(screen.getByTitle(/^Last activity:/)).toBeInTheDocument()
  })

  test('falls back to the shared summary line when the project has no brief', () => {
    renderRow()
    expect(
      screen.getByText('OIB/RIS building-compliance workspace. Add documents and a brief to ground Piloti.'),
    ).toBeInTheDocument()
  })
})
