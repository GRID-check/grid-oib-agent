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

  /**
   * The card's fallback brief is an invitation. Repeated verbatim down a list it
   * stops being one — it becomes the longest line on the page, on the rows that
   * carry the least. A row with no brief shows no second line instead.
   */
  test('leaves the brief line out entirely when the project has none', () => {
    renderRow()
    expect(
      screen.queryByText('OIB/RIS building-compliance workspace. Add documents and a brief to ground Piloti.'),
    ).not.toBeInTheDocument()
  })

  test('shows the brief when the project has one', () => {
    renderRow({
      project: makeProject({
        id: 'p1',
        name: 'Wohnbau Seestadt',
        profileDisplay: {
          title: 'Wohnbau Seestadt',
          summary: 'Wohnbau · 214 Wohneinheiten · GK 5 · Wien',
          keyFacts: [],
          missingInfo: [],
        },
      }),
    })
    expect(screen.getByText('Wohnbau · 214 Wohneinheiten · GK 5 · Wien')).toBeInTheDocument()
  })

  /**
   * `getProjectStatus` can only return `active`, so on a list the chip is the
   * same tinted pill on every row — a band of chroma carrying no information.
   * It stays on the card and comes back here when a second status exists.
   */
  test('does not repeat the constant status chip on every row', () => {
    renderRow()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
  })
})
