import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { DocumentStatusBadge } from './document-status'

describe('DocumentStatusBadge queue position', () => {
  it("says how many of the office's uploads are ahead while the document waits", () => {
    render(<DocumentStatusBadge status="pending" queueAhead={3} />)
    expect(screen.getByText('Waiting · 3 files ahead')).toBeInTheDocument()
  })

  it('keeps the status word when nothing is ahead, or the document has settled', () => {
    const { rerender } = render(<DocumentStatusBadge status="pending" queueAhead={0} />)
    expect(screen.queryByText(/ahead/)).toBeNull()
    rerender(<DocumentStatusBadge status="completed" queueAhead={3} />)
    expect(screen.queryByText(/ahead/)).toBeNull()
  })
})
