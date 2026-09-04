'use client'

/**
 * Dev preview for the RIS reader: what a legal source opens onto INSIDE Piloti.
 *
 * The whole point of the surface is that it no longer leaves the product, so
 * the preview must not either — the fetch is stubbed on `window.fetch` for this
 * route alone and answers with a real Bauordnung excerpt, which is what the
 * route would receive from `/api/ris/document`. No backend, no network, no RIS.
 *
 * Two variants, because the surface has two claims:
 *
 *   (default)  the reader with the cited passage found and marked, scrolled to.
 *              This is the difference the change exists for: a citation that
 *              used to hand the reader a browser tab and a page of statute now
 *              puts them on the sentence.
 *   `failed`   RIS unreachable. The dialog says so and keeps the outbound link,
 *              because the reading copy is the thing that failed and the
 *              authoritative publication is still there. A viewer that spins
 *              forever would be the worse answer, and it is the one this route
 *              exists to make impossible to ship by accident.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { RisDocumentDialog } from '@/features/knowledge/components/ris-document-dialog'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'

const URL = 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006'

const PASSAGE =
  'Über die Fluchtwege ist sicherzustellen, dass die Benützerinnen und Benützer im Brandfall ins Freie oder in einen gesicherten Bereich gelangen können.'

const TEXT = [
  'Bauordnung für Wien',
  '',
  '§ 108. Schutz vor Brandgefahr',
  '',
  '(1) Bauwerke sind so zu planen und auszuführen, dass bei einem Brand die',
  'Tragfähigkeit der Konstruktion während eines bestimmten Zeitraumes erhalten',
  'bleibt und die Entstehung und Ausbreitung von Feuer und Rauch innerhalb des',
  'Bauwerkes begrenzt wird.',
  '',
  '(2) ' + PASSAGE,
  '',
  '(3) Die Rettung von Menschen und Tieren sowie wirksame Löscharbeiten müssen',
  'möglich sein. Die Anforderungen der OIB-Richtlinie 2 in der für Wien',
  'verbindlich erklärten Fassung sind einzuhalten.',
  '',
  '§ 109. Ausführung der Fluchtwege',
  '',
  '(1) Die nutzbare Breite eines Fluchtweges darf 1,20 m nicht unterschreiten.',
  'Türen in Fluchtwegen müssen in Fluchtrichtung aufschlagen, sofern sie von',
  'mehr als 20 Personen benützt werden.',
].join('\n')

export default function RisSourcePreview() {
  const params = useSearchParams()
  const variant = params.get('variant') ?? 'default'
  const [stubbed, setStubbed] = useState(false)

  // The stub is installed BEFORE the dialog mounts (which is what the flag
  // gates), because the dialog fetches on open and a real request would leave
  // the preview waiting on a backend it is designed not to need.
  useEffect(() => {
    const original = window.fetch
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.startsWith('/api/ris/document')) return original(input, init)
      if (variant === 'failed') {
        return new Response('{"error":"upstream"}', { status: 502 })
      }
      return new Response(
        JSON.stringify({
          url: URL,
          title: 'Bauordnung für Wien § 108',
          text: TEXT,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof window.fetch
    setStubbed(true)
    return () => {
      window.fetch = original
    }
  }, [variant])

  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <div className="bg-background min-h-dvh p-6" data-testid="ris-source-preview">
      {stubbed && (
        <RisDocumentDialog
          open
          onOpenChange={() => {}}
          url={URL}
          title="Bauordnung für Wien § 108"
          highlight={PASSAGE}
          highlightColor="var(--source-law)"
          headerChip={<SourceSignalChip signal="law">Rechtsquelle (RIS)</SourceSignalChip>}
        />
      )}
    </div>
  )
}
