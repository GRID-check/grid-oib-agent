'use client'

/**
 * Dev preview for the share dialog (spec SH-17) — the REAL `ShareDialog` driven by
 * the real `useSharing` hook, with a module-scope fetch shim standing in for the
 * BFF. Not linked from anywhere; 404s outside development.
 *
 * The shim is installed at MODULE SCOPE on purpose: React runs a child's effects
 * before its parent's, so `useSharing` would fire its request before a parent
 * `useEffect` could install one — the shim would race and lose (see
 * `docs/ux/visual-screenshots.md` and `src/app/dev/document-grid/page.tsx`). It is
 * browser + dev guarded and idempotent via a `window.__sharingShim` flag, and it
 * answers the mutations too, so the controls are live in the preview.
 *
 * Variants, so each interesting surface is its own piece of evidence:
 *   - default            — an owner: visibility control, roster controls, invite
 *                          picker (including a colleague who is NOT in the project
 *                          and is therefore shown disabled with the reason, SH-19).
 *   - `?variant=viewer`  — a collaborator: no controls, but the full "who has
 *                          access" answer, and the Leave action.
 *   - `?variant=project` — the thread is project-wide, so the roster mixes derived
 *                          members (no per-person controls — there is no per-person
 *                          deny) with named grants, and narrowing back to private is
 *                          the confirmation that lists who loses access.
 *   - `?variant=invite`  — the same owner surface with a solo roster, so the invite
 *                          picker (all three candidate kinds, blocked row included)
 *                          fits on screen instead of below the fold.
 *   - `?variant=failure` — a refused mutation (the last-owner invariant), because
 *                          "the change did not happen" must be visible.
 *   - `?variant=loading` — the skeleton.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is the product's
 * primary language, so the committed evidence must carry the copy most users
 * actually see — and the scaffolding around these previews is German already, so
 * without the pin a screenshot mixes both languages and the primary-language copy
 * cannot be reviewed at all.
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { ShareDialog } from '@/features/collaboration/components/ShareDialog'
import { useSharing } from '@/features/collaboration/hooks/use-sharing'
import type {
  AccessReason,
  ResourceAccessEntry,
  ResourceRole,
  ResourceSharingState,
  ShareCandidate,
} from '@/lib/sharing/types'

const ME = 'u-matthias'
const RESOURCE_ID = 'c-atrium'

type Variant = 'default' | 'viewer' | 'invite' | 'project' | 'failure' | 'loading'

const VARIANTS: readonly Variant[] = ['viewer', 'invite', 'project', 'failure', 'loading']

const readVariant = (): Variant => {
  if (typeof window === 'undefined') return 'default'
  const value = new URLSearchParams(window.location.search).get('variant') as Variant | null
  return value && VARIANTS.includes(value) ? value : 'default'
}

const entry = (
  userId: string,
  name: string,
  role: ResourceRole,
  reason: AccessReason,
  grantedBy: string | null = null,
): ResourceAccessEntry => ({
  person: { userId, name, email: `${name.split(' ')[0]?.toLowerCase()}@buero.at`, profilePictureUrl: null },
  role,
  reason,
  grantedBy,
})

/**
 * One entry per access *reason*, and no more: three rows is enough to show the
 * grouping and keeps the whole surface — including the blocked invite row, which
 * is the point of SH-19 — above the fold in a 1200×900 screenshot. The larger,
 * scrolling rosters are covered by `/dev/access-overview`.
 */
const ENTRIES: ResourceAccessEntry[] = [
  entry(ME, 'Matthias Bigl', 'owner', 'creator'),
  entry('u-anna', 'Anna Weber', 'collaborator', 'grant', ME),
  // Granted by someone who is no longer on the roster → the anonymous fallback.
  entry('u-zoe', 'Zoe Vogel', 'viewer', 'grant', 'u-deactivated'),
]

/** Project-wide: derived members alongside the named grants. */
const PROJECT_ENTRIES: ResourceAccessEntry[] = [
  entry(ME, 'Matthias Bigl', 'owner', 'creator'),
  entry('u-anna', 'Anna Weber', 'collaborator', 'grant', ME),
  entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
  entry('u-markus', 'Markus Hofer', 'viewer', 'visibility-project'),
]

const CANDIDATES: ShareCandidate[] = [
  {
    person: { userId: 'u-sabine', name: 'Sabine Gruber', email: 'sabine@buero.at', profilePictureUrl: null },
    alreadyHasAccess: false,
    needsProjectAccess: false,
  },
  {
    person: { userId: 'u-anna', name: 'Anna Weber', email: 'anna@buero.at', profilePictureUrl: null },
    alreadyHasAccess: true,
    needsProjectAccess: false,
  },
  {
    // In the organisation, NOT in the project: shown disabled with the reason.
    person: { userId: 'u-eva', name: 'Eva Ritter', email: 'eva@buero.at', profilePictureUrl: null },
    alreadyHasAccess: false,
    needsProjectAccess: true,
  },
]

const sharingState = (variant: Variant): ResourceSharingState => ({
  resourceType: 'conversation',
  resourceId: RESOURCE_ID,
  visibility: variant === 'project' ? 'project' : 'private',
  // Conversations expose private/project in phase 1 — the dialog must offer
  // exactly this and nothing more.
  allowedVisibilities: ['private', 'project'],
  myRole: variant === 'viewer' ? 'collaborator' : 'owner',
  canManage: variant !== 'viewer',
  canEscalate: false,
  shared: true,
  // The invite variant is deliberately solo, so the picker is what the shot is of.
  entries:
    variant === 'invite' ? [ENTRIES[0]] : variant === 'project' ? PROJECT_ENTRIES : ENTRIES,
})

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __sharingShim?: boolean }
  if (!w.__sharingShim) {
    w.__sharingShim = true
    const real = window.fetch.bind(window)
    const base = `/api/sharing/conversation/${RESOURCE_ID}`
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const variant = readVariant()

      if (url.startsWith(`${base}/candidates`)) {
        return Response.json(CANDIDATES)
      }
      if (url.startsWith(`${base}/grants`) || url.startsWith(base)) {
        // `loading` never answers, so the skeleton is what gets captured.
        if (variant === 'loading') return new Promise<Response>(() => {})
        // `failure` refuses every mutation with a machine-readable reason, which
        // is what the dialog localises.
        const method = (init?.method ?? 'GET').toUpperCase()
        if (variant === 'failure' && method !== 'GET') {
          return Response.json(
            { error: 'CONFLICT', code: 'CONFLICT', details: { reason: 'last-owner' } },
            { status: 409 },
          )
        }
        return Response.json(sharingState(variant))
      }
      // The live channel is deliberately absent: the dialog must render fully from
      // the plain fetch (spec RT-3/RT-4), which is what a screenshot proves.
      if (url.startsWith('/api/stream')) {
        return new Response(null, { status: 404 })
      }
      return real(input, init)
    }
  }
}

function Preview({ variant }: { variant: Variant }): JSX.Element {
  const sharing = useSharing('conversation', RESOURCE_ID, true)
  const [open, setOpen] = useState(true)

  // The `failure` variant needs a refused mutation on screen, so it fires one as
  // soon as the state has loaded. The shim answers it with `409 last-owner`.
  const loaded = Boolean(sharing.state)
  useEffect(() => {
    if (variant !== 'failure' || !loaded) return
    void sharing.changeRole('u-anna', 'viewer')
    // Once is enough — this is a fixture, not a retry loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, loaded])

  return (
    <>
      {!open && (
        <button
          type="button"
          className="rounded-lg border bg-card px-4 py-2 text-sm font-medium shadow-xs"
          onClick={() => setOpen(true)}
        >
          Teilen öffnen
        </button>
      )}
      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        resourceId={RESOURCE_ID}
        sharing={sharing}
        currentUserId={ME}
      />
    </>
  )
}

export default function ShareDialogDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the variant after mount (not during render) so server and client markup
  // agree — the same trick the inbox preview uses.
  const [variant, setVariant] = useState<Variant | null>(null)
  useEffect(() => {
    setVariant(readVariant())
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="share-dialog-preview"
        className="mx-auto flex max-w-3xl flex-col gap-6 p-8 text-foreground"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Teilen</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Die eine Freigabe-Oberfläche: Sichtbarkeit, Personen mit Zugriff und Einladen.
          </p>
        </div>

        {variant && <Preview variant={variant} />}
      </main>
    </I18nProvider>
  )
}
