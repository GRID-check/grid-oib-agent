import { afterEach, describe, expect, test, vi } from 'vitest'
import { startBrowserDownload } from './browser-download'

describe('startBrowserDownload', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  test('clicks a temporary attachment link and leaves the page in place', () => {
    const click = vi.fn()
    const created: HTMLAnchorElement[] = []
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = original(tagName)
      if (tagName === 'a') {
        created.push(element as HTMLAnchorElement)
        element.click = click
      }
      return element
    })

    startBrowserDownload('https://files.example/plan.pdf?sig=1', 'Einreichplan.pdf')

    expect(created).toHaveLength(1)
    expect(created[0].href).toBe('https://files.example/plan.pdf?sig=1')
    expect(created[0].download).toBe('Einreichplan.pdf')
    expect(created[0].target).toBe('_blank')
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.body.contains(created[0])).toBe(false)
  })

  test('does nothing with an empty url', () => {
    startBrowserDownload('')
    expect(document.body.childElementCount).toBe(0)
  })
})
