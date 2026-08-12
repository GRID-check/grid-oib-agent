import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@/test-utils'
import { NavigationTrail, NavigationTrailLabel } from './navigation-trail'
import { readTrail, type ReturnTrail } from '@/lib/navigation/return-trail'

const visits = (...paths: string[]): ReturnTrail => paths.map((path) => ({ path }))

let pathname = '/app/projects'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

beforeEach(() => {
  window.sessionStorage.clear()
  pathname = '/app/projects'
})

describe('NavigationTrail', () => {
  test('records each visited location for the tab', async () => {
    const { rerender } = render(<NavigationTrail />)
    await waitFor(() => expect(readTrail()).toEqual(visits('/app/projects')))

    pathname = '/app/projects/p1/files'
    rerender(<NavigationTrail />)
    await waitFor(() =>
      expect(readTrail()).toEqual(visits('/app/projects', '/app/projects/p1/files'))
    )

    pathname = '/app/archiv'
    rerender(<NavigationTrail />)
    await waitFor(() =>
      expect(readTrail()).toEqual(visits('/app/projects', '/app/projects/p1/files', '/app/archiv'))
    )
  })

  test('unwinds the trail when the reader returns to a location already on it', async () => {
    const { rerender } = render(<NavigationTrail />)
    pathname = '/app/archiv'
    rerender(<NavigationTrail />)
    await waitFor(() => expect(readTrail()).toEqual(visits('/app/projects', '/app/archiv')))

    pathname = '/app/projects'
    rerender(<NavigationTrail />)
    await waitFor(() => expect(readTrail()).toEqual(visits('/app/projects')))
  })

  test('names the location it is mounted on, recording the visit if nobody has yet', async () => {
    // Child effects run before the root recorder's, so this must not depend on
    // the entry already existing.
    pathname = '/app/projects/p1/files'
    render(<NavigationTrailLabel label="Stadthaus Wien" />)
    await waitFor(() =>
      expect(readTrail()).toEqual([{ path: '/app/projects/p1/files', label: 'Stadthaus Wien' }])
    )

    render(<NavigationTrail />)
    await waitFor(() =>
      expect(readTrail()).toEqual([{ path: '/app/projects/p1/files', label: 'Stadthaus Wien' }])
    )
  })

  test('renders nothing', () => {
    const { container } = render(<NavigationTrail />)
    expect(container).toBeEmptyDOMElement()
  })
})
