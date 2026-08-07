/**
 * The inbox page — one place per user, per organization, that answers "what
 * needs me?" (spec IB-1, IB-18).
 *
 * Lives above projects, like the org Archiv: an inbox spans every project the
 * user can see, so it gets the org top bar rather than a project rail.
 *
 * The flag check is a `notFound()`, not a polite empty card. Collaboration is
 * dark-launched (NF-7/NF-8), and with the flag off the product must behave
 * exactly as it did before — which means this route does not exist. The BFF
 * routes the list calls are gated the same way, so the two cannot disagree.
 */

import { type Metadata } from 'next'
import { notFound } from 'next/navigation'

import { withPageSession } from '@/lib/auth/require-auth'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { getNavFlags } from '@/lib/authz/nav'
import { OrgTopbar } from '@/components/shell'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { InboxList } from '@/features/collaboration/components'
import { isAuthRequired } from '@/lib/auth/auth-required'


export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('collaboration')
  return { title: t('inbox.title') }
}

export default async function InboxPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    if (!isCollaborationEnabled(session)) {
      notFound()
    }

    const navFlags = await getNavFlags(session)
    const t = await getTranslations('collaboration')

    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <OrgTopbar
          user={{ name: session.name, email: session.email }}
          authRequired={isAuthRequired()}
          canManageOrganization={navFlags.canManageOrganization}
          canViewOrganization={navFlags.canViewOrganization}
          canManagePlatform={navFlags.canManagePlatform}
          canAccessArchiv={navFlags.canAccessArchiv}
          canCollaborate={navFlags.canCollaborate}
        />
        <main id="main-content" className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
          <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
          <div className="mt-7">
            <InboxList />
          </div>
        </main>
      </div>
    )
  })
}
