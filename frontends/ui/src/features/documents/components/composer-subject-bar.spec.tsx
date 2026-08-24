/**
 * The bar is the only thing that can put a restored subject back together.
 *
 * A conversation persists the subject's resource id and nothing else, so after
 * a reload the bar is handed an id with no filename and no shelf — and the
 * filename IS the retrieval identity that goes on the wire as
 * `focus_file_name`. The old guard ("fetch only when there is no title") meant
 * a subject restored with a title but no filename never looked the document up
 * at all.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { ComposerSubject } from '@/features/chat/types'

import { ComposerSubjectBar } from './composer-subject-bar'

const STATUS_BODY = {
  id: 'doc-aufsicht',
  filename: '220724_Aufsicht_1_100.pdf',
  displayName: 'Aufsicht 1:100',
  scope: 'project',
}

function renderBar(subject: ComposerSubject, onResolved = vi.fn()) {
  const view = render(
    <I18nProvider initialLocale="de" fixedLocale>
      <ComposerSubjectBar
        subject={subject}
        projectId="proj-1"
        onClear={() => undefined}
        onResolved={onResolved}
      />
    </I18nProvider>
  )
  /** Re-render with a NEW handler identity, as a keystroke in the composer does. */
  const rerenderWithFreshHandler = (): void => {
    view.rerender(
      <I18nProvider initialLocale="de" fixedLocale>
        <ComposerSubjectBar
          subject={subject}
          projectId="proj-1"
          onClear={() => undefined}
          onResolved={(identity) => onResolved(identity)}
        />
      </I18nProvider>
    )
  }
  return Object.assign(onResolved, { rerenderWithFreshHandler })
}

describe('ComposerSubjectBar identity recovery', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => STATUS_BODY })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('recovers filename and shelf for a subject restored from an id alone', async () => {
    const onResolved = renderBar({ resourceType: 'document', resourceId: 'doc-aufsicht', title: null })

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        title: 'Aufsicht 1:100',
        filename: '220724_Aufsicht_1_100.pdf',
        shelf: 'project',
      })
    )
  })

  test('looks the document up even when a title is already present', async () => {
    // The regression: a title alone used to short-circuit the lookup, so the
    // subject kept a title and never gained the filename the wire needs.
    const onResolved = renderBar({
      resourceType: 'document',
      resourceId: 'doc-aufsicht',
      title: 'Aufsicht 1:100',
    })

    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(onResolved.mock.calls[0][0]).toMatchObject({ filename: '220724_Aufsicht_1_100.pdf' })
  })

  test('does not look up a subject that is already complete', async () => {
    renderBar({
      resourceType: 'document',
      resourceId: 'doc-aufsicht',
      title: 'Aufsicht 1:100',
      filename: '220724_Aufsicht_1_100.pdf',
      shelf: 'project',
    })

    await screen.findByTestId('composer-subject-bar')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('looks a document up once, not once per composer re-render', async () => {
    // The bar's lookup used to depend on the caller's handler identity, and the
    // composer above it passes an inline arrow and re-renders on every
    // keystroke. A document that never completes the subject — deleted, or no
    // longer readable — therefore meant one request per character typed.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => null }))
    const onResolved = renderBar({
      resourceType: 'document',
      resourceId: 'doc-gone',
      title: null,
    })

    await screen.findByTestId('composer-subject-bar')
    expect(fetch).toHaveBeenCalledTimes(1)

    onResolved.rerenderWithFreshHandler()
    onResolved.rerenderWithFreshHandler()
    onResolved.rerenderWithFreshHandler()

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('ignores a scope the client does not know rather than passing it through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...STATUS_BODY, scope: 'something-new' }),
      })
    )
    const onResolved = renderBar({ resourceType: 'document', resourceId: 'doc-aufsicht', title: null })

    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(onResolved.mock.calls[0][0].shelf).toBeUndefined()
  })
})
