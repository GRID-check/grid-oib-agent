'use client'

/**
 * Dev preview for the hand-off banner — the REAL `AwaitingBanner` in its three
 * meaningful states, stacked so one screenshot carries the whole story of the
 * agent's deliberate silence (spec MN-8/MN-9):
 *
 *   1. waiting for ONE person, with the question that was asked,
 *   2. waiting for SEVERAL, each releasable on its own (MN-10),
 *   3. waiting for YOU — the stronger, attention-carrying variant.
 *
 * Fetch-free: the banner renders the state it is handed (the thread reads it from
 * `useAwaitingState`), and `onRelease` resolves locally here. Not linked from
 * anywhere; 404s outside development.
 *
 * Pinned to German — the product's primary language — so the evidence carries the
 * copy that ships, whatever locale cookie the capture runs with.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { AwaitingBanner } from '@/features/collaboration/components/AwaitingBanner'
import { I18nProvider } from '@/i18n'
import type { AwaitingStateResponse, PendingMentionView } from '@/lib/mentions/types'

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@arch-buero.at`,
  profilePictureUrl: null,
})

const MATTHIAS = person('u-matthias', 'Matthias Bigl')

const now = Date.parse('2026-07-29T10:00:00Z')
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

const request = (overrides: Partial<PendingMentionView> = {}): PendingMentionView => ({
  id: 'r-anna',
  person: person('u-anna', 'Anna Weber'),
  requestedBy: MATTHIAS,
  note: null,
  anchorId: 'm-9',
  createdAt: ago(23),
  ...overrides,
})

const ONE: AwaitingStateResponse = {
  pending: [
    // The note is the asker's own message text now (spec MN-12): nothing in the UI
    // ever set an explicit note, so the field was permanently null and this block
    // was unreachable. It defaults to the message server-side, which is what makes
    // the quoted question real rather than a fixture.
    request({
      note: 'Ist die Annahme richtig, dass das Atrium als eigener Brandabschnitt geführt wird?',
    }),
  ],
  awaitingMe: false,
}

const MANY: AwaitingStateResponse = {
  pending: [
    request(),
    request({
      id: 'r-markus',
      person: person('u-markus', 'Markus Hofer'),
      createdAt: ago(90),
    }),
    request({
      id: 'r-sabine',
      person: person('u-sabine', 'Sabine Gruber'),
      createdAt: ago(150),
    }),
  ],
  awaitingMe: false,
}

const ME: AwaitingStateResponse = {
  pending: [
    request({
      id: 'r-me',
      person: person('u-me', 'Matthias Bigl'),
      requestedBy: person('u-anna', 'Anna Weber'),
      note: 'Kannst du die Fluchtwegbreite im Kern B bestätigen?',
      createdAt: ago(6),
    }),
  ],
  awaitingMe: true,
}

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </h2>
    {children}
  </section>
)

export default function AwaitingBannerPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Released ids disappear from the derived state, exactly as the server's answer
  // would make them — so the preview's actions behave like the real thing.
  const [released, setReleased] = useState<string[]>([])
  const withoutReleased = (state: AwaitingStateResponse): AwaitingStateResponse => ({
    ...state,
    pending: state.pending.filter((entry) => !released.includes(entry.id)),
  })
  const onRelease = async (requestId: string): Promise<boolean> => {
    setReleased((current) => [...current, requestId])
    return true
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
    <main
      data-testid="awaiting-banner-preview"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8"
    >
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Warten auf eine Antwort</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Der Assistent hält sich zurück — und sagt, warum.
        </p>
      </header>

      <Section label="Eine Person">
        <AwaitingBanner
          awaiting={withoutReleased(ONE)}
          onRelease={onRelease}
          onAskAgent={() => undefined}
        />
      </Section>

      <Section label="Mehrere Personen">
        <AwaitingBanner
          awaiting={withoutReleased(MANY)}
          onRelease={onRelease}
          onAskAgent={() => undefined}
        />
      </Section>

      <Section label="Ihre Einschätzung ist gefragt">
        {/* The one state that carries "Rückfrage an …": the reader was asked
            something they may not be able to answer without more information, and
            typing that question as plain text is the move that misfires. */}
        <AwaitingBanner
          awaiting={withoutReleased(ME)}
          onRelease={onRelease}
          onAskAgent={() => undefined}
          onAskBack={() => undefined}
        />
      </Section>
    </main>
    </I18nProvider>
  )
}
