/**
 * The diagram's palette, and the three claims it makes.
 *
 * Every one of these was a real defect before it was a test: the drawing was
 * mermaid's lavender because nobody chose a theme; it would have been a
 * hard-coded ink ramp if the values were written down here instead of read; and
 * the filed copy would have carried the reader's dark theme onto a printed page
 * if the paper palette could not be read while `.dark` is on the root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diagramThemeVariables, resetDiagramPaletteCache } from './diagram-palette'

const LIGHT = {
  '--card': '#ffffff',
  '--foreground': '#1f2023',
  '--muted-foreground': '#6f706c',
  '--muted': '#f2f2f0',
  '--accent': '#ececea',
}
const DARK = {
  '--card': '#232120',
  '--foreground': '#f2f1ee',
  '--muted-foreground': '#a7a5a1',
  '--muted': '#2e2c28',
  '--accent': '#373531',
}

/**
 * A canvas that converts the way a browser's does — the module uses one because
 * the real tokens are authored in `oklch()` and khroma, which mermaid hands its
 * colours to, cannot parse that. Here the values are already hex, so the stub
 * only has to be an honest identity: assign, read back, report the bytes.
 */
function stubCanvas(): void {
  let fill = '#000000'
  const context = {
    get fillStyle(): string {
      return fill
    },
    set fillStyle(value: string) {
      if (/^#[0-9a-f]{6}$/i.test(value)) fill = value.toLowerCase()
    },
    clearRect: () => undefined,
    fillRect: () => undefined,
    getImageData: () => ({
      data: new Uint8ClampedArray([
        Number.parseInt(fill.slice(1, 3), 16),
        Number.parseInt(fill.slice(3, 5), 16),
        Number.parseInt(fill.slice(5, 7), 16),
        255,
      ]),
    }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
}

/** Tokens resolve off `<html>`, and which set depends on the `.dark` class. */
function stubTokens(): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) =>
          (document.documentElement.classList.contains('dark') ? DARK : LIGHT)[
            name as keyof typeof LIGHT
          ] ?? '',
      }) as unknown as CSSStyleDeclaration,
  )
}

beforeEach(() => {
  resetDiagramPaletteCache()
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.className = ''
})

describe('the palette is the product’s, not mermaid’s', () => {
  it('paints text and lines from the ink ramp', () => {
    stubCanvas()
    stubTokens()
    const variables = diagramThemeVariables('light')
    expect(variables?.primaryTextColor).toBe(LIGHT['--foreground'])
    expect(variables?.nodeTextColor).toBe(LIGHT['--foreground'])
    expect(variables?.lineColor).toBe(LIGHT['--muted-foreground'])
    expect(variables?.nodeBorder).toBe(LIGHT['--muted-foreground'])
    expect(variables?.mainBkg).toBe(LIGHT['--muted'])
  })

  it('names no colour outside the monochrome it was given', () => {
    // The defect this replaces was `#ECECFF` / `#9370DB` — mermaid's default
    // theme, inherited. Chroma of any kind belongs to the provenance signals,
    // and a Verfahrensablauf is not one.
    stubCanvas()
    stubTokens()
    const values = Object.values(diagramThemeVariables('light') ?? {}).filter(
      (value): value is string => typeof value === 'string' && value.startsWith('#'),
    )
    expect(values.length).toBeGreaterThan(10)
    for (const hex of values) {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
      // Warm paper and warm charcoal are near-neutral by construction; a hue
      // would show up as a wide channel spread.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12)
    }
  })

  it('keeps every label at AA against the ground it is drawn on, in both themes', () => {
    // The module's whole argument for a two-palette split — and against
    // `--source-auto` — is a contrast number: a label needs 4.5:1 against its
    // own ground, and no single ink clears that on both white and #232120.
    // Asserting it here is what keeps the argument true if a token moves. A
    // drawing that goes to a Behörde cannot have unreadable labels.
    stubCanvas()
    stubTokens()
    const channel = (c: number): number => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((at) => channel(Number.parseInt(hex.slice(at, at + 2), 16)))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') document.documentElement.classList.add('dark')
      const v = diagramThemeVariables(theme)
      if (!v) throw new Error('palette unavailable')
      // Node text on the node body, and edge/plane text on the inset plane —
      // the two pairings mermaid actually draws.
      expect(ratio(v.nodeTextColor as string, v.mainBkg as string)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(v.textColor as string, v.clusterBkg as string)).toBeGreaterThanOrEqual(4.5)
      // Lines are not text; AA's 3:1 non-text threshold is the bar for them.
      expect(ratio(v.lineColor as string, v.background as string)).toBeGreaterThanOrEqual(3)
      document.documentElement.className = ''
      resetDiagramPaletteCache()
    }
  })

  it('reads the paper palette while the reader is in dark mode, and puts the class back', () => {
    // The bytes that get FILED are always drawn on paper. Custom properties
    // inherit, so there is no element that resolves the light palette under
    // `.dark` — the module toggles the class, reads, and restores inside one
    // task.
    stubCanvas()
    stubTokens()
    document.documentElement.classList.add('dark')
    const paper = diagramThemeVariables('light')
    expect(paper?.background).toBe(LIGHT['--card'])
    expect(paper?.primaryTextColor).toBe(LIGHT['--foreground'])
    expect(paper?.darkMode).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('reads the charcoal palette for the screen', () => {
    stubCanvas()
    stubTokens()
    const screen = diagramThemeVariables('dark')
    expect(screen?.primaryTextColor).toBe(DARK['--foreground'])
    expect(screen?.darkMode).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('sets the diagram’s type on the body ramp rather than mermaid’s 16px', () => {
    stubCanvas()
    stubTokens()
    expect(diagramThemeVariables('light')?.fontSize).toBe('14px')
  })
})

describe('the stubbed tokens are the shipped tokens', () => {
  // Every assertion above resolves tokens through `stubTokens`, because jsdom
  // computes no `oklch()` and khroma cannot parse one either. That makes the
  // contrast test only as true as these stubs, so the stubs are pinned to the
  // hexes `styles/tokens.css` documents beside each token. A token moved
  // without its comment still slips past — but a token moved WITH its comment,
  // which is the repo's convention, fails here instead of shipping a drawing
  // whose labels no longer pass AA.
  it('matches the hexes tokens.css documents for the ramp the diagram uses', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    // jsdom serves `import.meta.url` over http, so the path is resolved from the
    // vitest root instead.
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

    // `--foreground: var(--ink); /* #1f2023 */` — the value may be a var(), so
    // the documented hex in the trailing comment is what is compared.
    const documented = (token: string, from: number): string | null => {
      const at = css.indexOf(`  ${token}:`, from)
      if (at === -1) return null
      const line = css.slice(at, css.indexOf('\n', at))
      return /\/\*[^*]*?(#[0-9a-f]{6})/i.exec(line)?.[1]?.toLowerCase() ?? null
    }
    // The light block comes first in the file; the dark block follows it. The
    // marker is anchored to the start of a line because `.dark` also appears in
    // the light block's prose.
    const darkFrom = css.indexOf('\n.dark {')
    expect(darkFrom).toBeGreaterThan(0)

    for (const [token, expected] of Object.entries(LIGHT)) {
      const hex = documented(token, 0)
      if (hex) expect(`light ${token} ${hex}`).toBe(`light ${token} ${expected}`)
    }
    for (const [token, expected] of Object.entries(DARK)) {
      const hex = documented(token, darkFrom)
      if (hex) expect(`dark ${token} ${hex}`).toBe(`dark ${token} ${expected}`)
    }
    // Guard the guard: if the file stops documenting hexes, the loops above
    // become vacuous and would pass silently.
    expect(documented('--muted-foreground', 0)).toBe(LIGHT['--muted-foreground'])
    expect(documented('--foreground', darkFrom)).toBe(DARK['--foreground'])
  })
})

describe('when the design system is not there', () => {
  it('answers null rather than a palette of written-down hexes', () => {
    // `render-diagram.ts` falls back to mermaid's own theme on null. A fallback
    // ramp spelled out here is exactly the drift the module exists to prevent.
    stubCanvas()
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration,
    )
    expect(diagramThemeVariables('light')).toBeNull()
  })
})
