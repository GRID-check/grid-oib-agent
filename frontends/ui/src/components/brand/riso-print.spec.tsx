import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import manifest from '@/lib/art/art.json'
import { artImage, type ArtId } from '@/lib/art'
import { RisoPrint } from './riso-print'

const PUBLIC = path.resolve(__dirname, '../../../public')
const ids = Object.keys(manifest.art) as ArtId[]

describe('RisoPrint', () => {
  it('offers both densities by width, so the browser can land one on device pixels', () => {
    const { container } = render(<RisoPrint id="vignetten/bauplatz/empty" />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('srcset')).toMatch(
      /-320\.webp\?v=[0-9a-f]{8} 320w, .*-640\.webp\?v=[0-9a-f]{8} 640w$/
    )
    // The slot is 320 CSS px from sm up and exactly half below: never a size the layout picks.
    expect(img).toHaveAttribute('sizes', '(min-width: 640px) 320px, 160px')
    expect(img).toHaveAttribute('width', '320')
    expect(img.getAttribute('src')).toMatch(/-320\.webp\?v=/)
    expect(img.style.getPropertyValue('--art-w')).toBe('320px')
    expect(img).toHaveClass('max-w-none')
  })

  it('is decorative: the heading beside it already says what it shows', () => {
    const { container } = render(<RisoPrint id="vignetten/planschrank/empty" />)
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('aria-hidden', 'true')
  })

  it('sits on dark mode as a paper sheet, not inverted', () => {
    const { container } = render(<RisoPrint id="vignetten/abstecken/empty" />)
    const img = container.querySelector('img')!
    expect(img).toHaveClass('dark:rounded-md', 'dark:shadow-sm')
    expect(img.className).not.toMatch(/invert/)
  })
})

// The riso harness (frontends/web/art/riso/check.mjs) is the full gate; this is
// the app's own half of it, so an app-only change that drops or orphans a file
// fails here even when the web job does not run.
describe('the app art manifest', () => {
  it('names only files that exist in public/art', () => {
    for (const id of ids) {
      for (const f of artImage(id)
        .srcSet.split(', ')
        .map((s) => s.split(' ')[0])) {
        expect(fs.existsSync(path.join(PUBLIC, f.replace(/\?.*$/, ''))), `${id}: ${f}`).toBe(true)
      }
    }
  })

  it('leaves no file in public/art unnamed', () => {
    const named = new Set(
      ids.flatMap((id) =>
        manifest.art[id].files.map((f) => path.basename(f.src.replace(/\?.*$/, '')))
      )
    )
    for (const file of fs.readdirSync(path.join(PUBLIC, 'art')))
      expect(named.has(file), file).toBe(true)
  })
})
