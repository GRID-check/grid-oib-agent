'use client'

/**
 * Dev preview for the `@` mention picker — the REAL `MentionPicker` with fixture
 * candidates, above a mock composer card that reproduces the composer's geometry
 * (same `max-w-3xl` column, same card surface), so the placement and the row design
 * can be reviewed and screenshotted without a backend.
 *
 * Fetch-free by construction: the component takes its candidates as props (the
 * composer is what talks to `useMentionCandidates`), so no shim is needed here.
 *
 * Variants via `?variant=`:
 *   - default      — two blocks. First the whole list: the assistant pinned first
 *                    in its own group, then the people in the chat, then the
 *                    colleagues who would be invited. Then the TYPED state, because
 *                    an empty query filters nothing and emphasises nothing — so the
 *                    first block alone can show neither, and the registry entry that
 *                    promised "the matched substring emphasised" was unbacked.
 *   - filter       — mid-typing (`@an`), so the matched fragment emphasis shows.
 *   - restricted   — the same list without invite rights: the invitable colleagues
 *                    are DISABLED with the reason, never hidden (MN-5, SH-19).
 *   - empty        — no match for the typed query.
 *   - loading      — the skeleton state.
 *
 * The mock textarea is wired to the picker's keyboard handle, so the preview is
 * genuinely operable (↑↓ to move, ↵/⇥ to insert, esc to close) rather than a still.
 *
 * Pinned to German: it is the product's primary language, so that is the copy the
 * evidence should carry regardless of which locale cookie the capture happens to
 * run with.
 */

import { useRef, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { ArrowUp, Layers } from 'lucide-react'

import { I18nProvider } from '@/i18n'
import {
  MentionPicker,
  type MentionPickerHandle,
} from '@/features/collaboration/components/MentionPicker'
import { AGENT_MENTION_ID, type MentionCandidate } from '@/lib/mentions/types'

const candidate = (
  userId: string,
  name: string,
  overrides: Partial<MentionCandidate> = {},
): MentionCandidate => ({
  targetId: userId,
  person: {
    userId,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@arch-buero.at`,
    profilePictureUrl: null,
  },
  isAgent: false,
  isParticipant: true,
  needsInvite: false,
  ...overrides,
})

const CANDIDATES: MentionCandidate[] = [
  {
    targetId: AGENT_MENTION_ID,
    person: { userId: AGENT_MENTION_ID, name: 'Piloti', email: null, profilePictureUrl: null },
    isAgent: true,
    isParticipant: true,
    needsInvite: false,
  },
  candidate('u-anna', 'Anna Weber'),
  // An umlaut name, on purpose: the search folds diacritics, so `@mu` has to find
  // "Müller". Without a single such name in the fixture that behaviour — and the
  // offset-safe emphasis that goes with it — could not appear in any screenshot.
  candidate('u-juergen', 'Jürgen Müller'),
  candidate('u-sabine', 'Sabine Gruber', { isParticipant: false, needsInvite: true }),
  candidate('u-daniel', 'Daniel Brandstetter', { isParticipant: false, needsInvite: true }),
]

/**
 * One picker over one mock composer — the geometry the picker actually ships in.
 * Self-contained (its own text state and its own handle) so a page can stack two
 * of them and each stays operable.
 */
function PickerBlock({
  label,
  query,
  canInvite,
  loading = false,
  prompt,
}: {
  label: string
  query: string
  canInvite: boolean
  loading?: boolean
  prompt: string
}): JSX.Element {
  const pickerRef = useRef<MentionPickerHandle>(null)
  const [text, setText] = useState(`${prompt}@${query}`)

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </h2>

      <MentionPicker
        ref={pickerRef}
        query={query}
        candidates={CANDIDATES}
        canInvite={canInvite}
        loading={loading}
        onSelect={(picked) => {
          const display = picked.isAgent ? 'Piloti' : picked.person.name
          setText((current) => `${current.replace(/@[^\s]*$/, '')}@${display} `)
        }}
      />

      {/* Mock composer card — same surface, radius and control row as the real one,
          so the picker is reviewed in the geometry it actually ships in. */}
      <div className="bg-card relative flex flex-col rounded-xl px-4 py-2.5 shadow-sm">
        <textarea
          className="max-h-52 min-h-[40px] resize-none border-0 bg-transparent px-1.5 py-1 text-[14.5px] leading-[1.5] outline-none"
          rows={2}
          value={text}
          aria-label="Mock composer"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              pickerRef.current?.move(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              pickerRef.current?.move(-1)
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              pickerRef.current?.selectActive()
            }
          }}
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <span className="bg-card text-muted-foreground shadow-xs inline-flex h-8 items-center gap-[7px] rounded-lg border px-[11px] text-[12.5px]">
            <Layers className="size-3.5" aria-hidden />
            Datengrundlage
          </span>
          <span className="bg-primary text-primary-foreground ml-auto inline-flex size-9 items-center justify-center rounded-lg shadow-md">
            <ArrowUp className="size-4" aria-hidden />
          </span>
        </div>
      </div>
    </section>
  )
}

export default function MentionPickerPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const params = useSearchParams()
  const variant = params?.get('variant') ?? 'default'
  const query = variant === 'empty' ? 'zzz' : variant === 'filter' ? 'an' : ''

  return (
    <I18nProvider initialLocale="de" fixedLocale>
    <main
      data-testid="mention-picker-preview"
      // `text-foreground`: the root layout only sets a surface colour, so the mock
      // composer's textarea (which carries no colour of its own, exactly like the
      // real one) inherited the browser default and rendered the typed `@…`
      // fragment black on black in dark mode — the one string the picker is
      // filtering on was invisible in half the evidence.
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 text-foreground"
    >
      <PickerBlock
        label={`Mention picker — ${variant}`}
        query={query}
        canInvite={variant !== 'restricted'}
        loading={variant === 'loading'}
        prompt="Ist das Atrium ein eigener Brandabschnitt, "
      />

      {/* The typed state, in the default shot rather than behind its own variant:
          with an empty query nothing is emphasised and nothing is filtered, so the
          block above cannot show either — and the search folds diacritics, which is
          precisely the behaviour a reader has to be able to check. `@mu` finds
          "Jürgen Müller" and emphasises the "Mü" it matched, not the two characters
          that happen to sit at that offset in the folded string. */}
      {variant === 'default' && (
        <PickerBlock
          label="Beim Tippen — ohne Umlaut geschrieben, mit Umlaut gefunden"
          query="mu"
          canInvite
          prompt="Das müsste "
        />
      )}
    </main>
    </I18nProvider>
  )
}
