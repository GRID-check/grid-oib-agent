'use client'

/**
 * Dev preview for the engagement notice (ADR-0036) — the line that states when
 * Piloti answers a message that tags nobody, and is also the control that changes it.
 *
 * Two shapes, and the difference is the whole point:
 *
 *   1. `ask` + a suggestion — a QUESTION about the future. `ask` is the default and
 *      stays the default however many people are in the thread, so a multi-person
 *      thread is OFFERED the alternative and never quietly switched to it.
 *   2. `mention` — the rule STATED, with the way back. Permanent rather than
 *      dismissible, because it has to be present at the moment somebody asks "why
 *      didn't Piloti answer that?", which is not the moment the mode was set.
 *
 * The third row is a viewer: they get the explanation for behaviour they can see, and
 * no control, because it is not their rule to change. (In `ask` mode a viewer sees
 * nothing at all — an offer nobody may accept is noise.)
 *
 * The first two rows hold the mode in local state, so pressing the control actually
 * performs the transition it promises — the way back from `mention` to `ask` is part
 * of what this preview is here to show. The third is static on purpose: a viewer has
 * no control to press.
 *
 * Not linked from anywhere; 404s outside development. Pinned to German (`fixedLocale`,
 * which also skips the provider's reconciliation against the viewer's own preference)
 * so the evidence carries the copy that ships whoever captures it.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { EngagementNotice } from '@/features/collaboration/components/EngagementNotice'
import { I18nProvider } from '@/i18n'
import type { ConversationEngagement } from '@/lib/db/schema'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
      {label}
    </h2>
    <div className="bg-card rounded-lg border px-4 py-3">{children}</div>
  </section>
)

/** A row whose control works: the accepted mode becomes the mode in force. */
const LiveRow = ({
  label,
  initialMode,
  suggestion = null,
}: {
  label: string
  initialMode: ConversationEngagement
  suggestion?: ConversationEngagement | null
}) => {
  const [mode, setMode] = useState<ConversationEngagement>(initialMode)
  return (
    <Row label={label}>
      <EngagementNotice
        mode={mode}
        suggestion={suggestion}
        onChange={(next) => {
          setMode(next)
          return true
        }}
      />
    </Row>
  )
}

export default function EngagementNoticePreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="engagement-notice-preview"
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8"
      >
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Wann Piloti antwortet</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Die Regel steht da, wo die Frage entsteht — und ist gleich der Schalter.
          </p>
        </header>

        <LiveRow
          label="Mehrere Personen — das Angebot, nicht die Änderung"
          initialMode="ask"
          suggestion="mention"
        />

        <LiveRow label="Nur auf Erwähnung — die Regel, mit dem Weg zurück" initialMode="mention" />

        {/* Static by design: no control, so nothing to transition. */}
        <Row label="Als Mitlesende — Erklärung ohne Schalter">
          <EngagementNotice mode="mention" onChange={() => true} canChange={false} />
        </Row>
      </main>
    </I18nProvider>
  )
}
