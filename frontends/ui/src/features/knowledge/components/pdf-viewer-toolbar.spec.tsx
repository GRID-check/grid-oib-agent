import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'

import { PdfControls } from './pdf-viewer-toolbar'

const controls = () =>
  render(
    <PdfControls
      pageCount={12}
      currentPage={3}
      onPage={vi.fn()}
      zoom={1}
      maxZoom={4}
      fit="width"
      onZoomStep={vi.fn()}
      onResetZoom={vi.fn()}
      onToggleFit={vi.fn()}
      searchOpen={false}
      onToggleSearch={vi.fn()}
      railOpen={false}
      onToggleRail={vi.fn()}
    />
  )

describe('PdfControls on a narrow stage', () => {
  it('never drops the page arrows, whatever the container width', () => {
    controls()
    for (const name of [/previous page/i, /next page/i]) {
      const button = screen.getByRole('button', { name })
      expect(button.className).not.toMatch(/@max-\w+:hidden/)
    }
  })

  it('keeps the fit-page toggle on touch and sheds the zoom steps instead', () => {
    controls()
    expect(screen.getByRole('button', { name: /fit whole page/i }).className).not.toMatch(/pointer-coarse:@max-\w+:hidden/)
    expect(screen.getByRole('button', { name: /zoom in/i }).className).toMatch(/pointer-coarse:@max-md:hidden/)
    expect(screen.getByRole('button', { name: /zoom out/i }).className).toMatch(/pointer-coarse:@max-md:hidden/)
  })
})

describe('PdfControls when the pill is longer than its stage', () => {
  it('scrolls the pill and never squeezes a control under its 28px target (WCAG 2.5.8)', () => {
    controls()
    // A flex item shrinks to its glyph (16px) unless told not to: the pill scrolls instead.
    expect(screen.getByTestId('pdf-floating-toolbar').className).toMatch(/overflow-x-auto/)
    for (const button of screen.getAllByRole('button')) expect(button.className).toMatch(/\bshrink-0\b/)
  })
})
