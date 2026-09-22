/**
 * Organisation → Anweisungen, at the surface a person actually uses.
 *
 * Three things this pins, and each one is a way the box could quietly stop
 * doing its job:
 *
 *   - the COUNTER is live and counts against the same 1500 the server enforces.
 *     A bound somebody only meets by being refused is a bound they meet with a
 *     paragraph already written.
 *   - over the cap, Save is REFUSED rather than the text being truncated. An
 *     instruction cut mid-sentence says something its author never wrote.
 *   - CLEAR is its own control. The box is often emptied on the way to
 *     rewriting it, so a Save that happened to be enabled must not be the thing
 *     that wipes the organization's instructions.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

import { ORG_INSTRUCTIONS_MAX_CHARS } from '@/lib/org-instructions/constants'
import { OrgInstructionsForm } from './org-instructions-form'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const box = (): HTMLTextAreaElement => screen.getByLabelText(/standing instructions/i)
const counter = (): HTMLElement => screen.getByTestId('org-instructions-counter')
const saveButton = (): HTMLElement => screen.getByRole('button', { name: /save instructions/i })
const clearButton = (): HTMLElement => screen.getByRole('button', { name: /^clear$/i })

const body = (): Record<string, unknown> =>
  JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>

describe('the instruction editor', () => {
  test('shows what the organization already told Piloti', () => {
    render(<OrgInstructionsForm initialInstructions="Assume Vienna." />)
    expect(box()).toHaveValue('Assume Vienna.')
    // Nothing has changed yet, so there is nothing to save.
    expect(saveButton()).toBeDisabled()
  })

  test('counts live, against the cap the server enforces', async () => {
    const user = userEvent.setup()
    render(<OrgInstructionsForm initialInstructions={null} />)

    expect(counter()).toHaveTextContent(`0 of ${ORG_INSTRUCTIONS_MAX_CHARS} characters`)
    await user.type(box(), 'Kurz.')
    expect(counter()).toHaveTextContent(`5 of ${ORG_INSTRUCTIONS_MAX_CHARS} characters`)
  })

  test('over the cap it refuses to save, and says by how much', async () => {
    render(<OrgInstructionsForm initialInstructions={null} />)

    // Pasted, not typed: a person meets this bound by pasting a house style
    // guide, not by typing 1501 characters.
    const tooLong = 'a'.repeat(ORG_INSTRUCTIONS_MAX_CHARS + 12)
    await userEvent.setup().click(box())
    await userEvent.setup().paste(tooLong)

    await waitFor(() => expect(counter()).toHaveTextContent('12 characters over'))
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toBeDisabled()
    // And nothing was silently shortened to fit.
    expect(box()).toHaveValue(tooLong)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('saving PUTs the block to the organization endpoint', async () => {
    const user = userEvent.setup()
    render(<OrgInstructionsForm initialInstructions={null} />)

    await user.type(box(), 'Lead with the verdict.')
    await user.click(saveButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/organization/instructions')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
    expect(body()).toEqual({ instructions: 'Lead with the verdict.' })
  })

  test('Clear is its own act, and sends the empty block deliberately', async () => {
    const user = userEvent.setup()
    render(<OrgInstructionsForm initialInstructions="Assume Vienna." />)

    await user.click(clearButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(body()).toEqual({ instructions: '' })
  })

  test('emptying the box does not by itself clear anything', async () => {
    const user = userEvent.setup()
    render(<OrgInstructionsForm initialInstructions="Assume Vienna." />)

    await user.clear(box())
    // Save is live, because the text genuinely changed — but nothing is written
    // until the person presses something.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('states the boundary: preferences, never a rule and never a value', () => {
    render(<OrgInstructionsForm initialInstructions={null} />)
    const hint = screen.getByText(/standing preferences on form, focus and workflow/i)
    expect(hint).toHaveTextContent(/never override/i)
    expect(hint).toHaveTextContent(/never supply a normative value/i)
    expect(hint).toHaveTextContent(/OIB requirement comes from the guideline/i)
  })
})
