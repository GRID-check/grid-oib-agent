/**
 * The loading state is the first thing anyone sees of a 150 MB model, and for
 * the better part of a minute it is the ONLY thing. These pin the two claims
 * it is allowed to make.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ViewerProgress } from './viewer-progress'

describe('ViewerProgress', () => {
  it('reports its real position while the download has one', () => {
    render(<ViewerProgress label="Modell wird geladen" percent={42} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('claims no position at all while parsing', () => {
    // Parsing has no known end. A bar reporting 0% for forty seconds is a bar
    // reporting a lie, and `aria-valuenow="0"` tells a screen-reader user
    // nothing is happening.
    render(<ViewerProgress label="Modell wird aufgebaut" percent={null} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('clamps a percentage that overshot rather than overflowing the track', () => {
    // A gzipped response whose declared length disagrees with the decoded byte
    // count can produce >100. The bar must not render wider than itself.
    render(<ViewerProgress label="lädt" percent={140} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('names the bar with what is actually happening', () => {
    render(<ViewerProgress label="Modell wird geladen" percent={10} />)
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('Modell wird geladen')
  })
})
