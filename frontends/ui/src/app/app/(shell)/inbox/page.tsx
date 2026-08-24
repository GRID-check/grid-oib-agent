/**
 * The inbox page — one place per user, per organization, that answers "what
 * needs me?" (spec IB-1, IB-18).
 *
 * Lives above projects, like the org Archiv: an inbox spans every project the
 * user can see, so it gets the org top bar rather than a project rail. The
 * way out is the same `BackLink` Organisation and Platform use — the tab's
 * return trail, not a guessed project — so leaving the inbox restores where
 * the reader actually came from.
 *
 * The gate is a `notFound()`, not a polite empty card — but it is no longer the
 * collaboration flag. It is `inboxIsReachable`, derived from the item-type
 * registry, because the inbox stopped being a collaboration-only surface once it
 * carried operational alerts (ADR-0042): gating the page on collaboration meant
 * a tenant without that feature could never see the warning that its storage was
 * filling up. The BFF routes apply the SAME per-type gate, so the two still
 * cannot disagree — and with every operational type removed from the registry
 * this reverts to exactly the dark-launch behaviour NF-7/NF-8 describe.
 */

import { type Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { withPageSession } from '@/lib/auth/require-auth'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { inboxIsReachable } from '@/lib/inbox/registry'
import { BackLink, ShellContent } from '@/components/shell'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { InboxList } from '@/features/collaboration/components'
import { PRODUCT_NAME } from '@/lib/brand'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('collaboration')
  return { title: t('inbox.title') }
}

export default async function InboxPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    if (!inboxIsReachable(isCollaborationEnabled(session))) {
      notFound()
    }

    const t = await getTranslations('collaboration')
    const tOrg = await getTranslations('organization')

    return (
      <ShellContent>
        <BackLink className="mb-6" fallbackHref="/app/projects" fallbackLabel={tOrg('backToApp')} />
        <PageHeader
          title={t('inbox.title')}
          subtitle={t('inbox.subtitle')}
          breadcrumb={
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href="/app/projects">{PRODUCT_NAME}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{t('inbox.title')}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          }
        />
        <div className="mt-7">
          <InboxList />
        </div>
      </ShellContent>
    )
  })
}
