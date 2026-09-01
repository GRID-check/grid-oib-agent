'use client'

/**
 * Dev preview for the base-knowledge SELECTION toolbar — the bar that replaces the
 * search row once documents are ticked, carrying the bulk actions: change document
 * type, re-index, remove.
 *
 * It is its own target because those controls are unreachable from a static page: they
 * render only once rows are selected, and the screenshot harness waits on a selector
 * rather than driving the UI. So this preview ticks the first two rows itself after
 * mount. That clicking lives here, in a dev-only route, rather than as a prop on the
 * production component — a preview may script the real component, but it must not make
 * the component grow an API only a preview uses.
 *
 * The fixture is in the CLIENT shape (camelCase), because the shim answers the browser
 * fetch directly and so bypasses the BFF's snake_case→camelCase mapping. Getting that
 * wrong renders an error page rather than a component, which is what a screenshot of a
 * crashed preview quietly commits.
 */

import { useEffect } from 'react'
import type { JSX } from 'react'
import { BaseKnowledge } from '@/app/app/(shell)/platform/base-knowledge'

const FILES = [
  {
    fileName: 'oib-richtlinie-2.pdf',
    state: 'ingested',
    origin: 'corpus',
    sizeBytes: 1_975_942,
    chunkCount: 214,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: '2026-08-12T09:14:00Z',
    summary: null,
    docClass: 'oib_richtlinie',
    displayTitle: 'OIB-Richtlinie 2 — Brandschutz, Ausgabe 2023',
  },
  {
    fileName: 'oib-richtlinie-6.pdf',
    state: 'ingested',
    origin: 'corpus',
    sizeBytes: 1_402_118,
    chunkCount: 64,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: '2026-08-12T09:15:00Z',
    summary: null,
    docClass: 'oib_richtlinie',
    displayTitle: 'OIB-Richtlinie 6 — Energieeinsparung, Ausgabe 2023',
  },
  {
    fileName: 'oenorm-b-1600.pdf',
    state: 'ingested',
    origin: 'uploaded',
    sizeBytes: 812_004,
    chunkCount: 38,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: '2026-08-13T11:02:00Z',
    summary: null,
    docClass: 'norm_extern',
    displayTitle: 'ÖNORM B 1600 — Barrierefreies Bauen',
  },
]

const STATUS = {
  collectionName: 'oib_base',
  collectionExists: true,
  collectionUpdatedAt: '2026-08-13T11:02:00Z',
  summary: {
    totalFiles: FILES.length,
    ingested: FILES.length,
    stale: 0,
    pending: 0,
    snapshot: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: FILES.reduce((sum, file) => sum + file.chunkCount, 0),
  },
  files: FILES,
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformKnowledgeSelectionShim?: boolean }
  if (!w.__platformKnowledgeSelectionShim) {
    w.__platformKnowledgeSelectionShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/knowledge-base')) {
        return Response.json(STATUS)
      }
      if (url.startsWith('/api/platform/knowledge/reingest')) {
        return Response.json({ status: 'pending', queued: [FILES[0].fileName], unknown: [], message: '' })
      }
      return real(input, init)
    }
  }
}

/** Tick the first two rows so the selection toolbar is on screen for the capture. */
function useSelectFirstRows(): void {
  useEffect(() => {
    const tick = window.setInterval(() => {
      const boxes = document.querySelectorAll<HTMLElement>('tbody [role="checkbox"], tbody input[type="checkbox"]')
      if (boxes.length < 2) return
      window.clearInterval(tick)
      boxes[0].click()
      boxes[1].click()
    }, 60)
    return () => window.clearInterval(tick)
  }, [])
}

export default function PlatformKnowledgeSelectionDevPage(): JSX.Element {
  useSelectFirstRows()
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8" data-testid="platform-knowledge-selection-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Base knowledge, selection actions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two documents ticked, so the toolbar swaps to the bulk bar: change document type, re-index the selected
          documents, remove them.
        </p>
      </div>
      <BaseKnowledge />
    </main>
  )
}
