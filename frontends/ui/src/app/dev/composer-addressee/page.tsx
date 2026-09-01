'use client'

/**
 * Dev preview for the composer's addressee statement (ADR-0034 addendum) — the real
 * `AddresseeIndicator` in all three of its renderings, inside a mock composer that
 * reproduces the real one's geometry (same `max-w-3xl` column, same card surface,
 * same hairline-separated action row), so the line can be reviewed and screenshotted
 * without a backend.
 *
 * Why this surface needs its own evidence: the whole point of the indicator is that
 * it *changes* as the state changes, and the three states cannot coexist in one
 * composer. Stacked here, the transition is legible in a single still:
 *
 *   1. **Silence** — the default, and where a thread always returns. It used to
 *      state "Geht an Piloti" here; that sentence described the case the user is
 *      already in and was rendered forever to do it. What remains on the line is
 *      the `@` offer, which is not a statement but the only thing in the product
 *      that teaches mentions exist. Captured deliberately: an empty row IS the
 *      evidence, and without it nothing would show that the other two are
 *      departures rather than the norm.
 *   2. **Geht an Anna Berger** — a person is tagged in the message being written, so
 *      the agent will stay out; paired with the "Piloti antwortet nicht" hint, which
 *      the user must see BEFORE sending.
 *   3. **Geht an den Chat** — the thread is waiting on a named person, so a plain
 *      message is a remark. This is the rendering the defect was about, and it is the
 *      one that has to carry the way back (`@Piloti eingeben, …`).
 *
 * The fourth row is the honest edge case: tagging a person *and* `@Piloti` addresses
 * both (MN-1), so both are named and the "Piloti stays quiet" hint is suppressed —
 * it would be a false statement.
 *
 * Fetch-free by construction: the component takes its state as props (the composer is
 * what reads `useAwaitingState`), so no shim is needed.
 *
 * Pinned to German: it is the product's primary language, so that is the copy the
 * evidence should carry regardless of the locale cookie the capture runs with.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { ArrowUp, AtSign, ChevronDown, Layers, ZoomIn } from 'lucide-react'

import { AddresseeIndicator } from '@/features/collaboration/components/AddresseeIndicator'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import { I18nProvider, useTranslations } from '@/i18n'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'

const ANNA: DraftMention = { targetId: 'user_anna', display: 'Anna Berger' }
const TOBIAS: DraftMention = { targetId: 'user_tobias', display: 'Tobias Kern' }
const PILOTI: DraftMention = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

/**
 * The composer's chrome, reproduced. Only the action row matters for this preview,
 * but the textarea above it is what makes the line's placement reviewable.
 *
 * The hint lines under the row are copies of the real composer's (InputArea) — the
 * indicator states the addressee, the hint explains the consequence, and the pair is
 * what has to be judged together.
 */
function MockComposer({
  text,
  children,
  hint,
}: {
  text: string
  children: React.ReactNode
  hint?: { icon: 'at' | 'agent'; body: string }
}): JSX.Element {
  return (
    <div className="bg-card relative flex flex-col rounded-xl px-4 py-2.5 shadow-sm">
      <p className="min-h-[40px] px-1.5 py-1 text-[14.5px] leading-[1.5] text-foreground">{text}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
        <span className="bg-card shadow-xs inline-flex h-8 items-center gap-[7px] rounded-lg border px-[11px]">
          <span className="border-status-active flex size-[14px] shrink-0 items-center justify-center rounded-full border border-dashed">
            <span className="bg-status-active size-[5px] rounded-full" />
          </span>
          <span className="text-foreground/85 text-[12.5px] font-medium">Wohnbau Nord</span>
          <ChevronDown className="text-muted-foreground size-3" aria-hidden />
        </span>
        <span className="bg-card text-muted-foreground shadow-xs inline-flex h-8 items-center gap-[7px] rounded-lg border px-[11px] text-[12.5px]">
          <Layers className="size-3.5" aria-hidden />
          Datengrundlage
          <span className="bg-muted text-foreground/80 inline-flex h-4 min-w-4 items-center justify-center rounded-md px-1 text-[10.5px] font-semibold tabular-nums">
            8
          </span>
        </span>
        <span className="bg-card text-muted-foreground shadow-xs inline-flex h-8 items-center gap-[7px] rounded-lg border px-3 text-[12.5px] font-medium">
          <ZoomIn className="size-3.5" aria-hidden />
          Deep Research
        </span>

        {children}

        <span className="bg-primary text-primary-foreground ml-auto inline-flex size-9 items-center justify-center rounded-lg shadow-md">
          <ArrowUp className="size-4" aria-hidden />
        </span>
      </div>

      {hint && (
        <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed">
          {/* Only the `@` hint carries a glyph. The agent hint's spark went with
              the rest of the composer's AI marks — see `InputArea`. */}
          {hint.icon === 'at' && (
            <AtSign className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden />
          )}
          <span>{hint.body}</span>
        </p>
      )}
    </div>
  )
}

const Eyebrow = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
    {children}
  </h2>
)

/**
 * The previews themselves. A child of the provider, not the page, so the hint copy
 * comes from the SAME dictionary entries the real composer uses — a preview with
 * hard-coded German would quietly drift from the product it is evidence of.
 */
function Previews(): JSX.Element {
  const t = useTranslations('collaboration')

  return (
    <>
      <section className="space-y-3">
        <Eyebrow>Standard — der Chat fragt Piloti, ohne es zu sagen</Eyebrow>
        {/* `onMentionSomeone` is passed because the real composer passes it, and
            without it this preview quietly captured a state the product never
            shows: the affordance renders only when a handler exists, so every
            screenshot taken here was evidence for a variant nobody sees. */}
        <MockComposer text="Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?">
          <AddresseeIndicator
            mentions={[]}
            awaitingHuman={false}
            onMentionSomeone={() => undefined}
          />
        </MockComposer>
      </section>

      <section className="space-y-3">
        <Eyebrow>Eine Person erwähnt — Piloti hält sich zurück</Eyebrow>
        <MockComposer
          text="@Anna Berger stimmt das für den Bestand?"
          hint={{
            icon: 'at',
            body: t('mentions.composerHint', { name: ANNA.display }),
          }}
        >
          <AddresseeIndicator mentions={[ANNA]} awaitingHuman={false} />
        </MockComposer>
      </section>

      <section className="space-y-3">
        <Eyebrow>Zwei Personen erwähnt</Eyebrow>
        <MockComposer
          text="@Anna Berger @Tobias Kern könnt ihr den Bestandsplan bestätigen?"
          hint={{
            icon: 'at',
            // The PLURAL key: German inflects the verb, so the singular string
            // rendered "Anna Berger, Tobias Kern wird gefragt" — wrong grammar,
            // and this preview reproduced it because it copies the real
            // composer's hint rather than sharing it.
            body: t('mentions.composerHintMany', {
              names: `${ANNA.display}, ${TOBIAS.display}`,
            }),
          }}
        >
          <AddresseeIndicator mentions={[ANNA, TOBIAS]} awaitingHuman={false} />
        </MockComposer>
      </section>

      <section className="space-y-3">
        <Eyebrow>Der Chat wartet auf eine Person — eine Nachricht ist eine Anmerkung</Eyebrow>
        <MockComposer
          text="Danke, lass dir Zeit."
          hint={{ icon: 'agent', body: t('mentions.addressee.agentHint') }}
        >
          <AddresseeIndicator mentions={[]} awaitingHuman />
        </MockComposer>
      </section>

      <section className="space-y-3">
        <Eyebrow>Person und Piloti erwähnt — beide werden adressiert</Eyebrow>
        <MockComposer text="@Anna Berger @Piloti bitte gemeinsam prüfen.">
          <AddresseeIndicator mentions={[ANNA, PILOTI]} awaitingHuman />
        </MockComposer>
      </section>
    </>
  )
}

export default function ComposerAddresseePreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="composer-addressee-preview"
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8 text-foreground"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Wer die Nachricht bekommt</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Die Aussage im Composer — überall dort, wo die Nachricht nicht an Piloti geht.
            Der Standardfall bleibt still; genau das macht die anderen lesbar.
          </p>
        </div>

        <Previews />
      </main>
    </I18nProvider>
  )
}
