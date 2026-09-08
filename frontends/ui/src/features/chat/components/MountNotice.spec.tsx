/**
 * A mount, said out loud in the transcript.
 *
 * The rule worth a test is the one that looks like a bug: undo does NOT delete
 * the notice. The mount happened, the transcript is a history, and a record
 * that edits its own past is not a record of anything.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MountCapNotice, MountNotice, MountRefusedNotice } from './MountNotice'

describe('who put the project in view', () => {
  it('names Piloti when the agent did it mid-turn', () => {
    render(<MountNotice projectName="Seestadt Nord" by="agent" />)
    expect(screen.getByText(/Piloti added project Seestadt Nord/)).toBeInTheDocument()
  })

  it('states it plainly when the reader did it', () => {
    render(<MountNotice projectName="Seestadt Nord" by="user" />)
    expect(screen.getByText('Seestadt Nord is in view.')).toBeInTheDocument()
  })

  it('says WHY when the reader arrived from that project', () => {
    render(<MountNotice projectName="Seestadt Nord" by="fromProject" />)
    expect(screen.getByText(/because you came from that project/)).toBeInTheDocument()
  })
})

describe('undo', () => {
  it('is offered while there is something to undo', async () => {
    const onUndo = vi.fn()
    render(<MountNotice projectName="Seestadt Nord" by="agent" onUndo={onUndo} />)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onUndo).toHaveBeenCalled()
  })

  it('leaves the notice standing and swaps its sentence — the mount HAPPENED', () => {
    render(<MountNotice projectName="Seestadt Nord" by="agent" onUndo={vi.fn()} undone />)

    expect(screen.getByTestId('mount-notice')).toBeInTheDocument()
    expect(screen.getByText('Seestadt Nord removed again.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('keeps the control when the undo itself failed, so a retry is one press away', () => {
    render(<MountNotice projectName="Seestadt Nord" by="agent" onUndo={vi.fn()} undoFailed />)

    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.getByText('That project could not be added right now.')).toBeInTheDocument()
  })
})

it('reports politely — it must not interrupt a streaming answer', () => {
  render(<MountNotice projectName="Seestadt Nord" by="agent" />)
  const notice = screen.getByTestId('mount-notice')
  expect(notice).toHaveAttribute('role', 'status')
  expect(notice).toHaveAttribute('aria-live', 'polite')
})

describe('a mount that did not happen', () => {
  it('names the project and the reason', () => {
    render(<MountRefusedNotice projectName="Seestadt Nord" code="no_access" />)
    expect(screen.getByText('Seestadt Nord could not be added.')).toBeInTheDocument()
    expect(screen.getByText('You cannot read that project.')).toBeInTheDocument()
  })

  it('says the shorter true thing when the refusal named no project', () => {
    render(<MountRefusedNotice projectName={null} code="not_found" />)
    expect(screen.getByText('That project could not be added right now.')).toBeInTheDocument()
  })
})

describe('the cap', () => {
  it('states the SERVER’s number and offers the one path past it', async () => {
    const onDeepResearch = vi.fn()
    render(<MountCapNotice max={5} onDeepResearch={onDeepResearch} />)

    expect(screen.getByText(/cannot read more than 5 projects/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start as Deep Research' }))
    expect(onDeepResearch).toHaveBeenCalled()
  })
})
