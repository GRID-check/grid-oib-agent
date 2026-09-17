import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { AuthorshipLine } from './authorship-line'

describe('AuthorshipLine', () => {
  it('says who wrote a generated report', () => {
    render(<AuthorshipLine authoredBy="agent" />)
    expect(screen.getByText('Created by Piloti')).toBeInTheDocument()
  })

  it('says nothing about a file a person uploaded', () => {
    // The default, and almost every row: stating "a human uploaded this" on
    // every card would be noise that buries the one case that matters.
    const { container } = render(<AuthorshipLine authoredBy="user" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing when the listing does not carry authorship yet', () => {
    const { container } = render(<AuthorshipLine authoredBy={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is text, not a chip and not an avatar', () => {
    // The whole point of the line: provenance is never rendered as
    // responsibility. A badge, a pill or an avatar here would be read as a
    // third party on the hook for the document beside the assignment faces.
    const { container } = render(<AuthorshipLine authoredBy="agent" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-slot="badge"]')).toBeNull()
    expect(container.firstElementChild?.tagName).toBe('P')
  })
})
