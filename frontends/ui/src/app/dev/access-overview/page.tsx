'use client'

/**
 * Dev preview for the "who has access" surfaces — the real `AccessChip`,
 * `ParticipantStrip` and `AccessOverview` with fixture data and no backend, so the
 * design can be reviewed and screenshotted (`docs/ux/visual-screenshots.md`). Not
 * linked from anywhere; 404s outside development.
 *
 * Deliberately fetch-free (the reference for that is `src/app/dev/cards/page.tsx`):
 * all three components are presentational, which is the property that lets a list
 * row render the access chip without opening a request per row. The share *dialog*,
 * which does read from the server, has its own preview at `/dev/share-dialog`.
 *
 * The fixtures exercise the states that are easy to get wrong:
 *   - `private` with nobody else (the lock) vs. `private` shared with three people
 *     (deliberately NOT a lock);
 *   - a roster whose access comes from three different reasons at once, so the
 *     "why" line is visible for each;
 *   - a `project`-wide thread, where the blanket rule is the headline and the named
 *     people are the exception;
 *   - a solo thread, which must render no strip at all.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is the product's
 * primary language, so the committed evidence must carry the copy most users
 * actually see — and the scaffolding around these previews is German already, so
 * without the pin a screenshot mixes both languages and the primary-language copy
 * cannot be reviewed at all.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { AccessChip } from '@/features/collaboration/components/AccessChip'
import { AccessOverview } from '@/features/collaboration/components/AccessOverview'
import { ParticipantStrip } from '@/features/collaboration/components/ParticipantStrip'
import type {
  AccessReason,
  ResourceAccessEntry,
  ResourceRole,
  ResourceSharingState,
} from '@/lib/sharing/types'

const ME = 'u-matthias'

const entry = (
  userId: string,
  name: string,
  role: ResourceRole,
  reason: AccessReason,
  grantedBy: string | null = null,
  profilePictureUrl: string | null = null,
): ResourceAccessEntry => ({
  person: { userId, name, email: `${name.split(' ')[0]?.toLowerCase()}@buero.at`, profilePictureUrl },
  role,
  reason,
  grantedBy,
})

const SHARED_ENTRIES: ResourceAccessEntry[] = [
  entry(ME, 'Matthias Bigl', 'owner', 'creator'),
  entry('u-anna', 'Anna Weber', 'collaborator', 'grant', ME),
  entry('u-markus', 'Markus Hofer', 'collaborator', 'grant', ME),
  entry('u-zoe', 'Zoe Vogel', 'viewer', 'grant', 'u-deactivated'),
]

const PROJECT_ENTRIES: ResourceAccessEntry[] = [
  entry(ME, 'Matthias Bigl', 'owner', 'creator'),
  entry('u-sabine', 'Sabine Gruber', 'owner', 'grant', ME),
  entry('u-anna', 'Anna Weber', 'collaborator', 'visibility-project'),
  entry('u-markus', 'Markus Hofer', 'collaborator', 'visibility-project'),
  entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
  entry('u-eva', 'Eva Ritter', 'viewer', 'visibility-project'),
  entry('u-jonas', 'Jonas Steiner', 'viewer', 'grant', 'u-sabine'),
]

const state = (
  visibility: ResourceSharingState['visibility'],
  entries: ResourceAccessEntry[],
): ResourceSharingState => ({
  resourceType: 'conversation',
  resourceId: 'c1',
  visibility,
  allowedVisibilities: ['private', 'project'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  shared: true,
  entries,
})

function Eyebrow({ children }: { children: string }): JSX.Element {
  return (
    <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  )
}

/** A panel the overview sits in, the way the share dialog frames it. */
function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-3">
      <Eyebrow>{title}</Eyebrow>
      <div className="rounded-lg border bg-card p-5 shadow-xs">{children}</div>
    </div>
  )
}

export default function AccessOverviewDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // `text-foreground` matters: the root layout only sets a surface colour, so
  // without it this preview's own headings inherit the browser default and go
  // black in dark mode (product pages set it on their shell wrapper).
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="access-overview-preview"
        className="mx-auto flex max-w-3xl flex-col gap-10 p-8 text-foreground"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Wer Zugriff hat</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Chip, Teilnehmerleiste und Übersicht — die Antwort auf „wer liest das mit?“.
          </p>
        </div>

        <section className="space-y-3">
          <Eyebrow>Zugriffs-Chip</Eyebrow>
          <div className="flex flex-wrap items-center gap-3">
            <AccessChip visibility="private" />
            <AccessChip visibility="private" sharedWith={1} />
            <AccessChip visibility="private" sharedWith={3} />
            <AccessChip visibility="project" />
            <AccessChip visibility="organization" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <AccessChip visibility="private" size="md" />
            <AccessChip visibility="private" sharedWith={3} size="md" />
            <AccessChip visibility="project" size="md" />
          </div>
        </section>

        <section className="space-y-3">
          <Eyebrow>Teilnehmerleiste</Eyebrow>
          <div className="flex flex-wrap items-center gap-8">
            <ParticipantStrip entries={SHARED_ENTRIES.slice(0, 2)} currentUserId={ME} onOpen={() => {}} />
            <ParticipantStrip entries={SHARED_ENTRIES} currentUserId={ME} onOpen={() => {}} />
            <ParticipantStrip entries={PROJECT_ENTRIES} currentUserId={ME} onOpen={() => {}} />
            {/* Solo: renders nothing at all — a single-participant private chat shows
                no collaboration furniture. The caption is the evidence. */}
            <div className="flex items-center gap-2">
              <ParticipantStrip entries={[SHARED_ENTRIES[0]]} currentUserId={ME} onOpen={() => {}} />
              <span className="text-xs text-muted-foreground">
                (allein im Chat — keine Leiste)
              </span>
            </div>
          </div>
        </section>

        {/* Toolbar context: the strip and the chip as they appear beside a thread
            title in the chat toolbar's left pill. */}
        <section className="space-y-3">
          <Eyebrow>Im Chat-Header</Eyebrow>
          <div className="flex w-fit items-center gap-1.5 rounded-lg border border-base bg-card/70 p-1.5 shadow-xs">
            <span className="text-sm text-muted-foreground">Wohnbau Nord</span>
            <span className="text-muted-foreground/60" aria-hidden>
              /
            </span>
            <span className="text-sm font-medium">Atrium – Rauchabschnitte GK 4</span>
            <ParticipantStrip entries={SHARED_ENTRIES} currentUserId={ME} onOpen={() => {}} />
            <AccessChip visibility="private" sharedWith={3} className="ml-1" />
          </div>
        </section>

        <Panel title="Übersicht — privat, mit drei Personen geteilt">
          <AccessOverview state={state('private', SHARED_ENTRIES)} currentUserId={ME} />
        </Panel>

        <Panel title="Übersicht — projektweit sichtbar">
          <AccessOverview state={state('project', PROJECT_ENTRIES)} currentUserId={ME} />
        </Panel>

        <Panel title="Übersicht — nur ich">
          <AccessOverview state={state('private', [SHARED_ENTRIES[0]])} currentUserId={ME} />
        </Panel>
      </main>
    </I18nProvider>
  )
}
