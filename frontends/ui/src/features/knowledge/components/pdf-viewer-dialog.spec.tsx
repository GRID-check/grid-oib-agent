import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PdfViewerDialog } from './pdf-viewer-dialog'

describe('PdfViewerDialog', () => {
  it('renders the document in an iframe when opened', () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="plan.pdf"
        src="https://example.test/plan.pdf"
      />,
    )
    const frame = screen.getByTitle('plan.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('https://example.test/plan.pdf')
  })

  // Regression: the shared DialogContent primitive carries `sm:max-w-lg`
  // (512px). Because tailwind-merge treats the `sm:` variant separately from an
  // unprefixed `max-w-*`, a plain override does NOT win at ≥sm viewports, so the
  // maximized viewer was silently clamped to 512px — tall-and-narrow, which
  // letterboxes wide/landscape drawings. The fix must override the `sm:` width
  // so the dialog can fill the viewport and render the document large.
  it('overrides the primitive sm width clamp so it is not capped at 512px', () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="section.pdf"
        src="https://example.test/section.pdf"
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('sm:max-w-[95vw]')
    // The narrow 512px clamp must not be the effective width.
    expect(dialog.className).not.toContain('sm:max-w-lg')
  })
})
