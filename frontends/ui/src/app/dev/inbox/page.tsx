'use client'

/**
 * Dev preview for the inbox surfaces — the real `InboxList`, `InboxItemRow` and
 * `InboxBadge` with fixture data and no backend, so the design can be reviewed
 * and screenshotted (spec NF-10). Not linked from anywhere; 404s outside
 * development.
 *
 * The fetch shim is installed at MODULE SCOPE on purpose: React runs a child's
 * effects before its parent's, so `useInboxList` would fire its request before a
 * parent `useEffect` could install a shim — the shim would race and lose (see
 * `docs/ux/visual-screenshots.md` and `src/app/dev/document-grid/page.tsx`). It is
 * browser + dev guarded and idempotent via a `window.__inboxShim` flag.
 *
 * The fixtures deliberately exercise every interesting row: an unread actionable
 * mention request, a resolved one, a grouped activity row (`count: 3`), a
 * shared-with-you row, a READ grouped row with `count: 0` (the third counted
 * title — nothing new since it was opened), the OPERATIONAL storage-quota
 * warning (ADR-0042 — no actor, `tone: 'warning'`, pointing at the organization
 * rather than a conversation), a row whose type this build does not know (the
 * runtime fallback that keeps one bad row from taking the page down), and an
 * INERT row whose target is gone — the last one is a security-visible state
 * (IB-13), so it must be in the evidence.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is the product's
 * primary language, so the committed evidence must carry the copy most users
 * actually see — and the scaffolding around these previews is German already, so
 * without the pin a screenshot mixes both languages and the primary-language copy
 * cannot be reviewed at all.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { Inbox as InboxIcon } from 'lucide-react'

import { I18nProvider } from '@/i18n'
import { InboxBadge, InboxList } from '@/features/collaboration/components'
import type { InboxItemView } from '@/lib/inbox/types'

const now = Date.parse('2026-07-29T10:00:00Z')
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

/*
  The project mail inbox (ADR-0075), in its three states: files filed with
  some skipped (the list of names and reasons, capped at ten, "+N weitere"),
  nothing filed (the zero form, the reasons and the cloud-link hint), and a
  mail the inbox gave up on. `?variant=mail` serves only these three.
*/
const MAIL_ITEMS: InboxItemView[] = [
  {
    id: 'm1',
    type: 'inbound_mail.filed',
    state: 'unread',
    actionable: false,
    resourceType: 'project',
    resourceId: 'p1',
    anchorId: 'msg-1',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files',
    subject: 'Einreichplanung Stand 12.09.',
    excerpt: null,
    related: null,
    variant: null,
    params: {
      filed: 4,
      skipped: 12,
      project: 'Wohnbau Mariahilf',
      skippedFiles: [
        { name: 'winmail.dat', reason: 'tnef' },
        { name: 'smime.p7s', reason: 'signature' },
        { name: 'Einladung Baubesprechung.ics', reason: 'calendar' },
        { name: 'Planexport_Makro.exe', reason: 'type' },
        { name: 'Luftbild_Bestand_hochaufgelöst_Gesamtareal_Mariahilf.tif', reason: 'size' },
        { name: 'Anhang-7.p7m', reason: 'encrypted' },
        { name: 'leer.pdf', reason: 'empty' },
        { name: 'Anhang', reason: 'unknown-type' },
        { name: 'Schnitt_A-A.pdf', reason: 'quota' },
        { name: 'Plan_101.pdf', reason: 'limit' },
      ],
    },
    createdAt: ago(2),
    updatedAt: ago(2),
  },
  {
    id: 'm2',
    type: 'inbound_mail.filed',
    state: 'unread',
    actionable: false,
    resourceType: 'project',
    resourceId: 'p1',
    anchorId: 'msg-2',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files',
    subject: 'Fotos Baustelle',
    excerpt: null,
    related: null,
    variant: null,
    params: {
      filed: 0,
      skipped: 2,
      project: 'Wohnbau Mariahilf',
      skippedFiles: [
        { name: 'image001.png', reason: 'embedded' },
        { name: 'image002.png', reason: 'embedded' },
      ],
    },
    createdAt: ago(9),
    updatedAt: ago(9),
  },
  {
    id: 'm3',
    type: 'inbound_mail.failed',
    state: 'unread',
    actionable: false,
    resourceType: 'project',
    resourceId: 'p1',
    anchorId: 'msg-3',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files',
    // No subject: the row says „aus Ihrer E-Mail" from the dictionary.
    subject: null,
    excerpt: null,
    related: null,
    variant: null,
    params: { project: 'Wohnbau Mariahilf' },
    createdAt: ago(31),
    updatedAt: ago(31),
  },
]

const ITEMS: InboxItemView[] = [
  ...MAIL_ITEMS,
  // Platform lane: a member elsewhere in the fleet sent product feedback. The
  // reader is a platform owner; the row lives in the platform organization.
  {
    id: 'i0',
    type: 'feedback.submitted',
    state: 'unread',
    actionable: false,
    resourceType: 'product_feedback',
    resourceId: 'f1',
    anchorId: null,
    actorName: 'Maria Huber',
    actorUserId: 'u-maria',
    count: 1,
    href: '/app/platform/feedback?report=f1',
    subject: 'Architekturbüro Nord',
    related: null,
    excerpt: 'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen, auch nach 10 Minuten.',
    variant: null,
    createdAt: ago(4),
    updatedAt: ago(4),
  },
  {
    id: 'i1',
    type: 'mention.requested',
    state: 'unread',
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c1',
    anchorId: 'm-9',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 1,
    href: '/app/projects/p1/chat?session=c1#m-9',
    subject: 'Atrium – Rauchabschnitte GK 4',
    related: null,
    excerpt:
      'Ist die Annahme richtig, dass das Atrium als eigener Brandabschnitt geführt wird? Dann bräuchten wir die Entrauchung im Kern.',
    variant: null,
    createdAt: ago(18),
    updatedAt: ago(18),
  },
  {
    id: 'i2',
    type: 'conversation.activity',
    state: 'unread',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c2',
    anchorId: null,
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 3,
    href: '/app/projects/p1/chat?session=c2',
    subject: 'Fluchtwegbreiten Bauteil Nord',
    related: null,
    excerpt: 'Die 1,20 m halten wir ein, aber der Treppenlauf im Kern B ist noch offen.',
    variant: null,
    createdAt: ago(52),
    updatedAt: ago(52),
  },
  {
    id: 'i3',
    type: 'conversation.shared_with_you',
    state: 'read',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c3',
    anchorId: null,
    actorName: 'Sabine Gruber',
    actorUserId: 'u-sabine',
    count: 1,
    href: '/app/projects/p1/chat?session=c3',
    subject: 'Stellplatznachweis Wohnbau Nord',
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(320),
    updatedAt: ago(320),
  },
  {
    id: 'i4',
    type: 'mention.requested',
    state: 'resolved',
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c4',
    anchorId: 'm-4',
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 1,
    href: '/app/projects/p1/chat?session=c4#m-4',
    subject: 'Barrierefreiheit Zugang Ost',
    related: null,
    excerpt: 'Passt so – die Rampe bleibt bei 6 %.',
    variant: null,
    createdAt: ago(1_500),
    updatedAt: ago(900),
  },
  {
    id: 'i5',
    type: 'mention.answered',
    state: 'read',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5',
    anchorId: 'm-12',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/chat?session=c5#m-12',
    subject: null,
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(2_600),
    updatedAt: ago(2_600),
  },
  {
    /*
      The OPERATIONAL row (ADR-0042) — the one item type that is not a
      collaboration event. It has to be in the evidence because it is the only
      row with no actor (a system alert that fell back to the actor placeholder
      would invent a colleague), the only one carrying `tone: 'warning'`, and the
      only one pointing at the organization rather than a conversation. It is
      also the row a tenant WITHOUT collaboration sees on its own, so how it
      reads unaccompanied is the whole design question.
    */
    id: 'i5a',
    type: 'storage.quota_warning',
    state: 'unread',
    actionable: false,
    resourceType: 'organization',
    resourceId: 'org-1',
    // The crossed threshold bucket, which is what makes the alert fire once per
    // crossing rather than once per sweep.
    anchorId: '80',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/organization/storage',
    // Locale-neutral token: the sentence around it is translated, the number is
    // not, so the server never formats an English sentence.
    subject: '82%',
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(140),
    updatedAt: ago(140),
  },
  {
    /*
      `count: 0` — a grouped row that has been READ, so nothing has arrived since.
      It is the ordinary state of every activity row a user has already opened, and
      it renders the third counted title (`titleNone`, "Neue Nachrichten"): picking
      `titleOne` for it made a group of twenty claim "1 neue Nachricht". Without a
      zero-count row in the fixture that string is unreachable, so the fix could not
      be seen.
    */
    id: 'i5b',
    type: 'conversation.activity',
    state: 'read',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5b',
    anchorId: null,
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 0,
    href: '/app/projects/p1/chat?session=c5b',
    subject: 'Abstandsflächen Bauteil Süd',
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(2_900),
    updatedAt: ago(2_050),
  },
  {
    /*
      A row whose type this build does not know — written by a newer deploy, or read
      across a rollback. It used to index `INBOX_TYPE_PRESENTATION` to `undefined`
      and throw, taking the whole /app/inbox route down rather than costing one row.
      The fallback presentation must therefore be in the evidence: one unremarkable
      row ("Es gibt etwas Neues"), not a blank page.

      The cast is the point: the type is deliberately outside the compile-time union,
      which is exactly the situation the runtime fallback exists for.
    */
    id: 'i5c',
    type: 'conversation.summarized' as unknown as InboxItemView['type'],
    state: 'read',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5c',
    anchorId: null,
    actorName: 'Piloti',
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/chat?session=c5c',
    subject: 'Brandschutzkonzept Bauteil West',
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(3_400),
    updatedAt: ago(3_400),
  },
  {
    // Target unshared/deleted: no link, no excerpt (IB-13/IB-14).
    id: 'i6',
    type: 'conversation.activity',
    state: 'inert',
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c6',
    anchorId: null,
    actorName: 'Klaus Berger',
    actorUserId: 'u-klaus',
    count: 2,
    href: null,
    subject: null,
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(4_100),
    updatedAt: ago(4_100),
  },
  // A newer Fassung of a document you follow (ADR-0099), as a sentence about
  // the person who uploaded it. The older document is the subject (without its
  // extension, as `fassungRowNames` writes it), the newer one the second name,
  // and the excerpt is the first line of what changed: the row's only body.
  // „Fassungen vergleichen" opens the newer one with the comparison open.
  {
    id: 'i-fassung',
    type: 'document.new_fassung',
    state: 'unread',
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'd-eg-b',
    actorName: 'Sabine Gruber',
    actorUserId: 'u-sabine',
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c',
    subject: 'Grundriss EG Index B',
    related: 'Grundriss EG Index C',
    excerpt: 'Die Tür zum Technikraum wurde verschoben, die Wandstärke im Kern von 25 auf 30 cm erhöht.',
    variant: null,
    createdAt: ago(9),
    updatedAt: ago(9),
  },
  // What Piloti did, told to the person whose act woke it (ADR-0106): which
  // mark in which document, why it did not work (the failure's `variant`),
  // and what to do now. The excerpt is what the mark says, or Piloti's question.
  {
    id: 'i-piloti-failed',
    type: 'piloti.work_failed',
    state: 'unread',
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-4',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-4',
    subject: 'Grundriss EG',
    related: '4',
    excerpt: 'Türbreite zum Technikraum prüfen',
    variant: 'budget',
    createdAt: ago(3),
    updatedAt: ago(3),
  },
  {
    id: 'i-piloti-asks',
    type: 'piloti.asks_you',
    state: 'unread',
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'mark-7',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files?doc=d-schnitt&review=1&mark=mark-7',
    subject: 'Schnitt A-A',
    related: '7',
    excerpt: 'Gilt für die Brüstung die Höhe ab Fertigfußboden oder ab Rohdecke?',
    variant: null,
    createdAt: ago(5),
    updatedAt: ago(5),
  },
  {
    id: 'i-piloti-done',
    type: 'piloti.work_done',
    state: 'read',
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-2',
    actorName: null,
    actorUserId: null,
    count: 0,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-2',
    subject: 'Grundriss EG',
    related: '2',
    excerpt: 'Fluchtweglänge im Kern B nachweisen',
    variant: null,
    createdAt: ago(40),
    updatedAt: ago(40),
  },
  {
    id: 'i-piloti-proposal',
    type: 'piloti.proposal_waiting',
    state: 'unread',
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c-ablage',
    anchorId: 'prop-1',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/chat?session=c-ablage',
    subject: null,
    related: null,
    excerpt: 'Grundriss EG.pdf, Schnitt A-A.pdf +3',
    variant: 'move',
    createdAt: ago(12),
    updatedAt: ago(12),
  },
]

/** Items the "needs me" filter returns: outstanding requests + unread. */
const PENDING = ITEMS.filter((item) => (item.actionable && item.state !== 'resolved') || item.state === 'unread')

/**
 * `?variant=empty` serves an inbox with nothing in it, so the crafted empty state
 * is captured as its own piece of evidence (NF-10 lists "empty inbox" separately).
 * `?variant=mail` serves only the three mail-inbox rows.
 * Read at request time rather than at install time so a client-side navigation
 * between the two variants still serves the right fixture.
 */
const variant = (): string | null =>
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('variant')
const isEmptyVariant = (): boolean => variant() === 'empty'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __inboxShim?: boolean }
  if (!w.__inboxShim) {
    w.__inboxShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const empty = isEmptyVariant()
      if (url.startsWith('/api/inbox/summary')) {
        return Response.json({ pending: empty ? 0 : PENDING.length })
      }
      if (url.startsWith('/api/inbox')) {
        if (empty) return Response.json({ items: [], pending: 0 })
        if (variant() === 'mail') return Response.json({ items: MAIL_ITEMS, pending: MAIL_ITEMS.length })
        const pendingOnly = url.includes('pendingOnly=true')
        return Response.json({ items: pendingOnly ? PENDING : ITEMS, pending: PENDING.length })
      }
      // The live channel is deliberately absent here: the list must render fully
      // from the plain fetch (spec RT-3/RT-4), which is what a screenshot proves.
      if (url.startsWith('/api/stream')) {
        return new Response(null, { status: 404 })
      }
      return real(input, init)
    }
  }
}

export default function InboxDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read after mount (not during render) so server and client markup agree — the
  // same trick the herleitung preview uses. The list is held back until then,
  // because its opening filter depends on the variant: the default view captures
  // EVERYTHING (the inert / answered / grouped rows only exist outside "needs
  // me"), while the empty variant captures the needs-me empty state.
  const [ready, setReady] = useState(false)
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    setEmpty(isEmptyVariant())
    setReady(true)
  }, [])

  // `text-foreground` matters: the root layout only sets a surface colour, so
  // without it this preview's own headings inherit the browser default and go
  // black in dark mode (product pages set it on their shell wrapper).
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="inbox-preview"
        className="mx-auto flex max-w-3xl flex-col gap-10 p-8 text-foreground"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Postfach</h1>
          <p className="mt-1 text-sm text-muted-foreground">Anfragen und Neuigkeiten aus Ihrem Team.</p>
        </div>

        {/* One list, so a single screenshot carries every row treatment. */}
        {ready && <InboxList initialFilter={empty ? 'needsMe' : 'all'} />}

        {!empty && (
          <section className="space-y-3">
            <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Badge
            </h2>
            <div className="flex flex-wrap items-center gap-6">
              {[1, 4, 128].map((count) => (
                <div key={count} className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Postfach</span>
                  <InboxBadge pending={count} />
                </div>
              ))}
              {/* Collapsed-rail case: icon tile with the pill in the corner. */}
              <div className="relative flex size-9 items-center justify-center rounded-[10px] border border-border bg-card shadow-xs">
                <InboxIcon className="size-4 text-muted-foreground" aria-hidden />
                <InboxBadge pending={7} className="absolute -top-1 -right-1 shadow-xs" />
              </div>
            </div>
          </section>
        )}
      </main>
    </I18nProvider>
  )
}
