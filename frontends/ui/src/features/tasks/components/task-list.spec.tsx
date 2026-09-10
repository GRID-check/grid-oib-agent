/**
 * The Aufgaben list (ADR-0051, and the review that found it missing).
 *
 * What is asserted is what one ROW has to answer, because that is the whole
 * reason the surface exists: a person delegated work in a chat and had nowhere
 * to ask what became of it. Kind, what was asked for, where it got to, how it
 * was judged, and WHERE THE RESULT IS.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { TaskList } from './task-list'
import type { TaskWireRow } from '../lib/task-view'

const task = (overrides: Partial<TaskWireRow> = {}): TaskWireRow => ({
  id: 'task-1',
  kind: 'document',
  title: 'Aktenvermerk Fluchtwege',
  goal: 'Fasse die Fluchtweglängen für die Einreichung zusammen',
  status: 'succeeded',
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: null,
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: '2026-09-01T10:00:00.000Z',
  finishedAt: '2026-09-01T10:04:00.000Z',
  error: null,
  ...overrides,
})

describe('TaskList', () => {
  test('says what was delegated, what kind of work it is, and where it got to', () => {
    render(<TaskList tasks={[task()]} />)

    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByTestId('task-kind')).toHaveTextContent('Document')
    expect(screen.getByTestId('task-status')).toHaveTextContent('Done')
    expect(
      screen.getByText('Fasse die Fluchtweglängen für die Einreichung zusammen'),
    ).toBeInTheDocument()
  })

  test('links to the document the result was filed as', () => {
    // The one thing a list of finished work has to answer. The row links there
    // rather than summarising the report, which is what the document is for.
    render(<TaskList tasks={[task({ filedDocumentId: 'doc-9' })]} />)
    expect(screen.getByTestId('task-document-link')).toHaveAttribute('href', '/documents/doc-9')
  })

  test('links to the conversation a chat task wrote into', () => {
    render(<TaskList tasks={[task({ kind: 'chat', conversationId: 'conv-3' })]} />)
    expect(screen.getByTestId('task-conversation-link')).toHaveAttribute('href', '/chat/conv-3')
  })

  test('carries the reviewer’s own words when the work was sent back', () => {
    // Verbatim: the next run reads exactly this string, and a paraphrase would
    // be an objection somebody else made.
    render(
      <TaskList
        tasks={[
          task({ review: 'rejected', reviewReason: 'Die Fluchtweglänge stimmt nicht' }),
        ]}
      />,
    )
    expect(screen.getByTestId('task-review')).toHaveTextContent('Sent back')
    expect(screen.getByTestId('task-review-reason')).toHaveTextContent(
      'Die Fluchtweglänge stimmt nicht',
    )
  })

  test('shows the worker’s sanitized error on a failure', () => {
    render(<TaskList tasks={[task({ status: 'failed', error: 'Das Budget war aufgebraucht.' })]} />)
    expect(screen.getByTestId('task-error')).toHaveTextContent('Das Budget war aufgebraucht.')
  })

  test('names who asked, so a shared project’s list is legible', () => {
    render(<TaskList tasks={[task()]} />)
    expect(screen.getByText(/Anna Berger/)).toBeInTheDocument()
  })

  test('shows an invitation rather than an empty box', () => {
    render(<TaskList tasks={[]} />)
    expect(screen.getByText('Nothing delegated yet')).toBeInTheDocument()
    expect(screen.queryByTestId('task-list')).toBeNull()
  })

  test('says the listing failed rather than claiming there is no work', () => {
    // „Noch nichts übergeben" over a failed request is the one lie this surface
    // could tell that a person would act on.
    render(<TaskList tasks={[]} failed />)
    expect(screen.getByText('The task list could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('Nothing delegated yet')).toBeNull()
  })

  test('shows a skeleton while it is loading, not the empty state', () => {
    render(<TaskList tasks={[]} loading />)
    expect(screen.getByTestId('task-list-loading')).toBeInTheDocument()
    expect(screen.queryByText('Nothing delegated yet')).toBeNull()
  })
})
