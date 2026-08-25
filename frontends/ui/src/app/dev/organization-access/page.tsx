'use client'

/**
 * Dev preview for Organization → People & access: the real `PeopleDirectory`,
 * `RoleCatalog` and `PermissionReference` with fixture data and no backend, so
 * the surface can be reviewed and screenshotted
 * (`docs/ux/visual-screenshots.md`). Not linked from anywhere; 404s outside
 * development.
 *
 * Deliberately fetch-free, the way `src/app/dev/cards/page.tsx` is: the roles
 * and permissions views read `lib/authz/catalog.ts` directly (that is the point
 * of them), and the directory is handed its roster as a prop. The one part that
 * does talk to a server — the WorkOS Users Management widget — is suppressed
 * with `showManagement={false}`, because it needs a real `/api/widgets/token`
 * response and would otherwise capture as a spinner or an error box. Its chrome
 * is already evidenced on the organization overview.
 *
 * `?view=` selects the captured scenario, because one page carrying all three
 * would be a 6000px screenshot nobody reviews:
 *   - (default)           the People directory, under the real sub-tab strip
 *   - `?view=roles`       the full role catalog, all four tiers
 *   - `?view=permissions` the full permission reference with the live inversion
 *
 * The roster fixture is chosen for the states that are easy to get wrong rather
 * than for a tidy list: a role the catalog knows, a *custom* role it has never
 * heard of (must degrade to the raw slug), a membership with no role at all, a
 * pending invitation, and a member WorkOS knows only by email.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is
 * the product's primary language, so the committed evidence must carry the copy
 * most users actually see — without the pin the screenshot's language depends on
 * whose dev server captured it.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PeopleDirectory } from '@/features/organization/components/people-directory'
import { PermissionReference } from '@/features/organization/components/permission-reference'
import { RoleCatalog } from '@/features/organization/components/role-catalog'
import type { OrganizationMemberWithRole } from '@/lib/organizations/service'
import { I18nProvider, useTranslations } from '@/i18n'

const MEMBERS: OrganizationMemberWithRole[] = [
  {
    id: 'user_01',
    email: 'matthias.bigl@buero.at',
    name: 'Matthias Bigl',
    roleSlug: 'admin',
    status: 'active',
  },
  {
    id: 'user_02',
    email: 'anna.weber@buero.at',
    name: 'Anna Weber',
    roleSlug: 'org-billing-admin',
    status: 'active',
  },
  {
    id: 'user_03',
    email: 'klaus.berger@buero.at',
    name: 'Klaus Berger',
    roleSlug: 'org-compliance-officer',
    status: 'active',
  },
  // A custom role provisioned in WorkOS that our catalog does not define: the
  // cell must show the slug rather than blanking or claiming "unknown".
  {
    id: 'user_04',
    email: 'sabine.gruber@buero.at',
    name: 'Sabine Gruber',
    roleSlug: 'org-fire-marshal',
    status: 'active',
  },
  {
    id: 'user_05',
    email: 'eva.ritter@buero.at',
    name: 'Eva Ritter',
    roleSlug: 'member',
    status: 'pending',
  },
  // WorkOS knows this membership by email only, and it carries no role.
  {
    id: 'user_06',
    email: 'jonas.steiner@buero.at',
    name: null,
    roleSlug: null,
    status: 'inactive',
  },
]

type View = 'people' | 'roles' | 'permissions'

const isView = (value: string | null): value is View =>
  value === 'people' || value === 'roles' || value === 'permissions'

function Preview(): JSX.Element {
  const t = useTranslations('organization')
  // Read the variant after mount rather than during render, so the markup the
  // server produced and the markup React hydrates are the same.
  const [view, setView] = useState<View>('people')
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view')
    if (isView(requested)) setView(requested)
  }, [])

  return (
    <main
      data-testid="organization-access-preview"
      className="text-foreground mx-auto flex w-full max-w-5xl flex-col gap-6 p-8"
    >
      <h1 className="text-xl font-semibold tracking-tight">{t('sections.access.title')}</h1>

      {/* The real sub-tab strip, so the shot shows how the three views are
          reached. `value` is controlled here because the route, not a click,
          decides which one is captured. */}
      <Tabs value={view}>
        <TabsList>
          <TabsTrigger value="people">{t('access.people.title')}</TabsTrigger>
          <TabsTrigger value="roles">{t('access.roles.title')}</TabsTrigger>
          <TabsTrigger value="permissions">{t('access.permissions.title')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === 'people' ? (
        <PeopleDirectory members={MEMBERS} showManagement={false} />
      ) : view === 'roles' ? (
        <RoleCatalog />
      ) : (
        <PermissionReference />
      )}
    </main>
  )
}

export default function OrganizationAccessDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
