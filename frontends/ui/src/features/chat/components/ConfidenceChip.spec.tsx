import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { ConfidenceChip } from './ConfidenceChip'

/**
 * ConfidenceChip surfaces the model's self-assessment and — when the backend
 * capped that confidence — explains WHY in the tooltip (PB-9). These specs
 * cover the reason→copy mapping and the fail-open generic behaviour.
 */
describe('ConfidenceChip', () => {
  test('renders nothing when confidence is absent', () => {
    const { container } = render(<ConfidenceChip confidence={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders the chip label for a self-assessed level', () => {
    render(<ConfidenceChip confidence="low" />)
    expect(screen.getByText('Confidence: low')).toBeInTheDocument()
  })

  test('shows the ungrounded reason in the tooltip when capped for grounding', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="low" cappedReason="ungrounded" />)

    await user.hover(screen.getByRole('button'))

    expect(
      (await screen.findAllByText(/Low confidence: answer not backed by sources\./)).length
    ).toBeGreaterThan(0)
  })

  test('shows the quote-unverified reason in the tooltip when a quote could not be verified', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="low" cappedReason="quote_unverified" />)

    await user.hover(screen.getByRole('button'))

    expect(
      (
        await screen.findAllByText(
          /Low confidence: a quote could not be verified verbatim against the source\./
        )
      ).length
    ).toBeGreaterThan(0)
  })

  test('falls back to the generic tooltip when no reason is present', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" />)

    await user.hover(screen.getByRole('button'))

    // Generic self-assessment tooltip, with no capped-reason sentence appended.
    expect((await screen.findAllByText(/It can be wrong\./)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Low confidence:/)).not.toBeInTheDocument()
  })

  test('shows the level meaning in the tooltip', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="high" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/directly grounded in the retrieved sources/)).length)
      .toBeGreaterThan(0)
  })

  test("shows the model's own reason verbatim in the tooltip when present", async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="medium" reason="Keine Quelle zur Sonderregel" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/Assistant's reason/)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/Keine Quelle zur Sonderregel/)).length).toBeGreaterThan(0)
  })

  test('shows no reason block when reason is absent', async () => {
    const user = userEvent.setup()
    render(<ConfidenceChip confidence="medium" />)

    await user.hover(screen.getByRole('button'))

    expect((await screen.findAllByText(/It can be wrong\./)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Assistant's reason/)).not.toBeInTheDocument()
  })
})
