/**
 * Element chips inside an answer.
 *
 * Two guarantees. The chip must go where the link said (an answer that names a
 * wall and opens a different one is worse than plain text), and it must announce
 * what it does — "AW 38" on its own does not tell a screen-reader user that
 * following it opens a 3D model.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IfcElementChip } from './ifc-element-chip'
import { parseElementLink } from '../lib/element-question'

function chip(href: string, label = 'AW 38'): void {
  const link = parseElementLink(href)
  if (!link) throw new Error(`not a model link: ${href}`)
  render(<IfcElementChip link={link}>{label}</IfcElementChip>)
}

describe('IfcElementChip', () => {
  it('links to the view the answer pointed at', () => {
    chip('/app/projects/p1/model?model=haus-a.ifc&element=1kTvXnbbzCWw8lcMd1dR4o&xray=1')
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute(
      'href',
      '/app/projects/p1/model?model=haus-a.ifc&element=1kTvXnbbzCWw8lcMd1dR4o&xray=1'
    )
  })

  it('keeps the answer’s own wording as the chip label', () => {
    chip('/app/projects/p1/model?element=abc', 'Brandwand BW-03')
    expect(screen.getByText('Brandwand BW-03')).toBeInTheDocument()
  })

  it('says out loud that it opens the element in the model', () => {
    chip('/app/projects/p1/model?element=abc')
    expect(screen.getByRole('link')).toHaveAccessibleName(/Bauteil abc im Modell öffnen/)
  })

  it('describes a storey link as a storey link', () => {
    chip('/app/projects/p1/model?storey=Erdgeschoss', 'Erdgeschoss')
    expect(screen.getByRole('link')).toHaveAccessibleName(/Geschoss Erdgeschoss im Modell öffnen/)
  })

  it('drops parameters the view does not define', () => {
    // An answer composed from a pasted URL can carry tracking junk; the chip
    // rebuilds the href from the parsed view rather than trusting the string.
    chip('/app/projects/p1/model?element=abc&utm_campaign=x')
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/projects/p1/model?element=abc')
  })
})
