'use client'

/**
 * Dev preview for the research-plan decision bubble — the REAL `AgentPrompt`
 * in the states that carry the three-way contract:
 *
 *   1. the live decision: the localized plan scaffolding and the three
 *      actions — Abbrechen, Kurz beantworten, Recherche starten,
 *   2. answered with „Kurz beantworten" — the echo says what the click meant,
 *      never the wire keyword (`shallow`),
 *   3. answered with „Abbrechen" — the cancellation receipt state,
 *   4. a LEGACY prompt restored from before the middle option existed — it
 *      keeps its two buttons, because sending `shallow` to the backend that
 *      wrote that envelope would be read as plan feedback.
 *
 * Fetch-free: the content strings are byte-for-byte what the clarifier's
 * `_format_plan_for_user` writes, and the respond callback resolves locally so
 * the first block is clickable in dev. Not linked from anywhere; 404s outside
 * development.
 *
 * Pinned to German — the product's primary language — so the evidence carries
 * the copy that ships, whatever locale cookie the capture runs with.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { AgentPrompt } from '@/features/chat/components/AgentPrompt'
import { useChatStore } from '@/features/chat/store'
import { I18nProvider } from '@/i18n'

const PLAN_BODY =
  '**Research Plan Preview**\n\n' +
  '**Title:** Brandschutzanforderungen für Gebäudeklasse 4 in Wien\n\n' +
  '**Sections:**\n' +
  '  1. Einleitung und Rechtsrahmen\n' +
  '  2. OIB-Richtlinie 2 im Überblick\n' +
  '  3. Anforderungen an Fluchtwege\n' +
  '  4. Brandabschnitte und Bauteile\n' +
  '  5. Abweichungen und Kompensation\n' +
  '  6. Zusammenfassung\n\n' +
  '---\n'

/** The current backend envelope, byte-stable (`_format_plan_for_user`). */
const THREE_WAY_CONTENT =
  PLAN_BODY +
  'Reply **approve** to proceed, **shallow** for a quick answer instead, ' +
  '**cancel** to dismiss, or provide feedback to revise the plan.'

/** The envelope persisted threads carry from before the middle option. */
const LEGACY_CONTENT =
  PLAN_BODY + 'Reply **approve** to proceed, **reject** to cancel, or provide feedback to revise the plan.'

const timestamp = new Date('2026-07-29T10:00:00Z')

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </h2>
    {children}
  </section>
)

export default function PlanApprovalPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // The buttons render only while a responder is registered — exactly the
  // condition the live chat creates. Clicking one settles the first block into
  // its answered state, so the preview behaves like the real thing.
  const [liveResponse, setLiveResponse] = useState<string | null>(null)
  useEffect(() => {
    useChatStore.setState({ respondToInteractionFn: setLiveResponse })
    return () => {
      useChatStore.setState({ respondToInteractionFn: null })
    }
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="plan-approval-preview"
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 text-foreground md:p-8"
      >
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Rechercheplan-Entscheidung</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Starten, kurz beantworten lassen — oder abbrechen, mit Quittung.
          </p>
        </header>

        <Section label="Die Entscheidung — drei Wege">
          <AgentPrompt
            id="preview-live"
            type="approval"
            content={THREE_WAY_CONTENT}
            isResponded={liveResponse !== null}
            response={liveResponse ?? undefined}
            timestamp={timestamp}
          />
        </Section>

        <Section label="Beantwortet: kurze Antwort angefordert">
          <AgentPrompt
            id="preview-shallow"
            type="approval"
            content={THREE_WAY_CONTENT}
            isResponded
            response="shallow"
            timestamp={timestamp}
          />
        </Section>

        <Section label="Beantwortet: abgebrochen">
          <AgentPrompt
            id="preview-cancel"
            type="approval"
            content={THREE_WAY_CONTENT}
            isResponded
            response="cancel"
            timestamp={timestamp}
          />
        </Section>

        <Section label="Alter Plan aus einem gespeicherten Verlauf (zwei Aktionen)">
          <AgentPrompt
            id="preview-legacy"
            type="approval"
            content={LEGACY_CONTENT}
            timestamp={timestamp}
          />
        </Section>
      </main>
    </I18nProvider>
  )
}
