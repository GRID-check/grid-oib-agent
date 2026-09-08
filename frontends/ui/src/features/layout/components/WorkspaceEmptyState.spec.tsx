/**
 * The Büro's empty canvas (WS-5).
 *
 * Two claims worth a test: three prompts of the three kinds are offered, and
 * pressing one PREFILLS rather than sends — the second is the one a refactor
 * could quietly break, because a send would look identical in a screenshot.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { en } from '@/i18n/dictionaries/en'
import { WorkspaceEmptyState } from './WorkspaceEmptyState'

const examples = en.chat.workspace.empty.examples

describe('WorkspaceEmptyState', () => {
  it('names the office and what it reads', () => {
    render(<WorkspaceEmptyState onPrompt={vi.fn()} />)

    expect(screen.getByText(en.chat.workspace.empty.title)).toBeInTheDocument()
    expect(screen.getByText(en.chat.workspace.empty.description)).toBeInTheDocument()
  })

  it('offers one example per outcome kind', () => {
    render(<WorkspaceEmptyState onPrompt={vi.fn()} />)

    const prompts = screen.getAllByRole('button').map((button) => button.textContent)
    expect(prompts).toEqual([examples.law, examples.register, examples.compare])
  })

  it('prefills the pressed example and sends nothing', async () => {
    const onPrompt = vi.fn()
    render(<WorkspaceEmptyState onPrompt={onPrompt} />)

    await userEvent.click(screen.getByRole('button', { name: examples.register }))

    expect(onPrompt).toHaveBeenCalledExactlyOnceWith(examples.register)
  })
})
