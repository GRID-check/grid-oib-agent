/**
 * Org-wide Archiv — a top-level document store that lives ABOVE projects and is
 * shared by every project in the organization (ADR-0024). Dark-launched behind
 * the `organization-archiv` gate; reachable by any org member, with uploads and
 * deletes gated on `org:archiv:manage`.
 */

import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { canManageArchiv } from '@/lib/authz/organizations'
import { FEATURE_FLAGS, isFeatureEnabled, isOrgArchivEnabled } from '@/lib/authz/feature-flags'
import { OrgTopbar } from '@/components/shell'
import { getTranslations } from '@/i18n/server'
import { ArchivWorkspace } from '@/features/documents/components/archiv-workspace'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('archiv')
  return { title: t('title') }
}

export default async function ArchivPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()

  // Dark-launch gate — a disabled org gets a 404, matching the workflows page.
  if (!isOrgArchivEnabled(session)) {
    notFound()
  }

  const navFlags = await getNavFlags(session)
  const t = await getTranslations('archiv')
  const canManage = canManageArchiv(session)
  const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        heading={t('title')}
        canManageOrganization={navFlags.canManageOrganization}
        canViewOrganization={navFlags.canViewOrganization}
        canManagePlatform={navFlags.canManagePlatform}
        canAccessArchiv={navFlags.canAccessArchiv}
      />
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden px-4 pb-4 md:px-8 md:pb-6">
        <Link
          href="/app/projects"
          className="my-3 inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('backToApp')}
        </Link>
        <main id="main-content" className="flex-1 overflow-hidden rounded-xl border">
          <ArchivWorkspace canManage={canManage} showMetadataPanel={showMetadataPanel} />
        </main>
      </div>
    </div>
  )
}
