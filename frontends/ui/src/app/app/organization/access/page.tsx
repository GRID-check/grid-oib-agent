/**
 * Organization → People & access. Who is here, what role they hold, what that
 * role actually does.
 *
 * The three views are three halves of one question, and they are sub-tabs rather
 * than three routes because they are read together: an admin looks a person up,
 * does not recognise their role, and needs the role's meaning without losing the
 * roster. Splitting them across the section nav would put a page load between
 * "Billing Admin" and "what is a Billing Admin", and would imply three
 * permissions where there is one.
 *
 * Only the roster is fetched, and it is fetched best-effort. Roles and
 * permissions render from `lib/authz/catalog.ts` — the same array the
 * provisioning script applies to WorkOS — so a WorkOS listing hiccup degrades
 * the directory card to its error state and leaves the other two views, and the
 * management widget, working. The shape of an organization's access model stays
 * knowable even when WorkOS is not answering.
 *
 * Shell chrome and the section nav live in the shared `layout.tsx`; this page
 * only gates, fetches and names its section.
 */

import { ShieldAlert } from 'lucide-react'

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PeopleDirectory } from '@/features/organization/components/people-directory'
import { PermissionReference } from '@/features/organization/components/permission-reference'
import { RoleCatalog } from '@/features/organization/components/role-catalog'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { canManageMembers } from '@/lib/authz/organizations'
import {
  listOrganizationMembersWithRoles,
  type OrganizationMemberWithRole,
} from '@/lib/organizations/service'
import { getTranslations } from '@/i18n/server'

export default async function OrganizationAccessPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const t = await getTranslations('organization')

  const header = (
    <PageHeader title={t('sections.access.title')} subtitle={t('sections.access.subtitle')} />
  )

  // This is the gate. The shared layout deliberately is not one — it only omits
  // the nav link — so a typed URL, a bookmark or a stale link lands here with no
  // permission at all, and the roster fetch below must never run for them.
  // Answer it politely rather than with a 403 wall, the same treatment the
  // organization overview gives a non-admin.
  if (!canManageMembers(session)) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="text-muted-foreground size-4" aria-hidden />
              {t('notAdmin.title')}
            </CardTitle>
            <CardDescription>{t('notAdmin.description')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  let members: OrganizationMemberWithRole[] = []
  let membersError = false
  try {
    members = await listOrganizationMembersWithRoles(session.organizationId)
  } catch {
    membersError = true
  }

  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* The tab labels are the views' own titles rather than a second set of
          strings: "People" heading the People card under a tab called anything
          else would be two names for one thing. */}
      <Tabs defaultValue="people">
        <TabsList>
          <TabsTrigger value="people">{t('access.people.title')}</TabsTrigger>
          <TabsTrigger value="roles">{t('access.roles.title')}</TabsTrigger>
          <TabsTrigger value="permissions">{t('access.permissions.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="people" className="mt-4">
          <PeopleDirectory members={members} error={membersError} />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RoleCatalog />
        </TabsContent>
        <TabsContent value="permissions" className="mt-4">
          <PermissionReference />
        </TabsContent>
      </Tabs>
    </div>
  )
}
