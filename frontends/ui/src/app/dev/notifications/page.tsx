'use client'

/**
 * Dev preview for system notifications (Web Push, ADR-0112): the "Benachrichtigungen"
 * section of the profile in every state it can be in, and the quiet offer in the
 * inbox. Not linked from anywhere; 404s outside development.
 *
 * The settings states render `NotificationSettingsView` from fixtures, because
 * most of them (an iPhone outside the Home Screen, a blocked browser) cannot be
 * produced by the browser doing the screenshot. The inbox is the REAL `InboxList`
 * with its REAL prompt: the fetch shim answers the push API and the inbox, and the
 * headless browser's own capabilities decide whether the offer is due.
 *
 * `?view=settings|inbox` shows one half. The shim is installed at module scope,
 * before any child effect runs (see `/dev/inbox`). Pinned to German, the
 * product's primary language.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { InboxList } from '@/features/collaboration/components'
import { FIXTURE_DEVICES, pushFixture } from '@/features/notifications/components/fixtures'
import { NotificationSettingsView } from '@/features/notifications/components/notification-settings'
import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import type { InboxItemView } from '@/lib/inbox/types'

const now = Date.parse('2026-10-15T10:00:00Z')
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

const ITEMS: InboxItemView[] = [
  {
    id: 'n1',
    type: 'mention.requested',
    state: 'unread',
    archived: false,
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
    excerpt: 'Ist die Brandwand an dieser Stelle nach EN 1366 geprüft?',
    variant: null,
    createdAt: ago(6),
    updatedAt: ago(6),
  },
  {
    id: 'n2',
    type: 'job.completed',
    state: 'unread',
    archived: false,
    actionable: false,
    resourceType: 'project',
    resourceId: 'p1',
    anchorId: 'run-1',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/automation?tab=jobs',
    subject: 'Wöchentliche Normenrecherche',
    related: null,
    excerpt: null,
    variant: null,
    createdAt: ago(48),
    updatedAt: ago(48),
  },
]

const config = { enabled: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __notificationsShim?: boolean }
  if (!w.__notificationsShim) {
    w.__notificationsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/notifications/push/config')) return Response.json(config)
      if (url.startsWith('/api/notifications/push/devices')) return Response.json({ devices: [] })
      if (url.startsWith('/api/notifications/push/preferences')) return Response.json({ preferences: DEFAULT_PUSH_PREFERENCES })
      if (url.startsWith('/api/inbox/summary')) return Response.json({ pending: 1 })
      if (url.startsWith('/api/inbox')) return Response.json({ items: ITEMS, pending: 1, counts: { requests: 1, unread: 1 }, hasMore: false, nextCursor: null })
      if (url.startsWith('/api/stream')) return new Response(null, { status: 404 })
      return real(input, init)
    }
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export default function NotificationsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  const [ready, setReady] = useState(false)
  const [view, setView] = useState<string | null>(null)
  useEffect(() => {
    setView(new URLSearchParams(window.location.search).get('view'))
    setReady(true)
  }, [])
  if (!ready) return <main />

  const turnedOn = pushFixture({
    thisDeviceOn: true,
    thisDeviceId: 'd-iphone',
    devices: FIXTURE_DEVICES,
    preferences: { showContent: true, categories: { ...DEFAULT_PUSH_PREFERENCES.categories, activity: false } },
  })

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main data-testid="notifications-preview" className="mx-auto flex max-w-3xl flex-col gap-10 p-4 text-foreground sm:p-8">
        {view !== 'inbox' && (
          <>
            <Section title="Profil · bereit, für dieses Gerät aus">
              <NotificationSettingsView push={pushFixture()} />
            </Section>
            <Section title="Profil · an, drei Geräte">
              <NotificationSettingsView push={turnedOn} />
            </Section>
            <Section title="Profil · iPhone, noch nicht installiert">
              <NotificationSettingsView push={pushFixture({ phase: 'needs-install' })} />
            </Section>
            <Section title="Profil · im Browser blockiert">
              <NotificationSettingsView push={pushFixture({ phase: 'denied', devices: [FIXTURE_DEVICES[1]!] })} />
            </Section>
            <Section title="Profil · Browser ohne Unterstützung">
              <NotificationSettingsView push={pushFixture({ phase: 'unsupported' })} />
            </Section>
            <Section title="Profil · wird geladen">
              <NotificationSettingsView push={pushFixture({ phase: 'loading' })} />
            </Section>
          </>
        )}
        {view !== 'settings' && (
          <Section title="Postfach mit dem Angebot (der echte Hinweis, der Browser entscheidet)">
            <InboxList initialFilter="all" />
          </Section>
        )}
      </main>
    </I18nProvider>
  )
}
