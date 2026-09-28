import { describe, expect, it } from 'vitest'
import { diagramFrameStyle, viewBoxWidth } from './diagram-size'

describe('the width a diagram is shown at', () => {
  it('reads the viewBox width, offsets and all', () => {
    expect(viewBoxWidth('<svg width="100%" viewBox="100 -57 1390 467.6">')).toBe(1390)
    expect(viewBoxWidth('<svg width="100%">')).toBeNull()
  })

  it('is the drawing’s own width, so a small diagram is not blown up to the column', () => {
    // A four-state stateDiagram is 236 px wide; at the column's 606 px its
    // labels printed at 36 px.
    expect(diagramFrameStyle('<svg viewBox="0 0 235.87 360">')).toEqual({
      width: '236px',
      maxWidth: 'max(100%, 177px)',
    })
  })

  it('shrinks a wide diagram at most to three quarters, then lets it scroll', () => {
    // A five-entry timeline is 1 390 px; fitted to 606 px its labels were 6 px.
    expect(diagramFrameStyle('<svg viewBox="100 -57 1390 467.6">')?.maxWidth).toBe('max(100%, 1043px)')
  })

  it('leaves an SVG without a viewBox to the column', () => {
    expect(diagramFrameStyle('<svg width="100%">')).toBeUndefined()
  })
})
