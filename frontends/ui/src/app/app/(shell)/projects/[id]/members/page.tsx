import { redirect } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'

interface ProjectMembersPageProps {
  params: Promise<{ id: string }>
}

/**
 * Legacy members route. The roster lives in the project hub's Members section
 * now; the route stays so old links and bookmarks keep working.
 *
 * Where it lands depends on the reader: the Members section is open only to
 * those who may manage the roster, and sending everyone else there would turn
 * an old link into a 404. They land on the project's Overview instead.
 */
export default async function ProjectMembersPage({
  params,
}: ProjectMembersPageProps): Promise<never> {
  const { id } = await params
  const target = await withPageSession(async (session) => {
    await requireProjectAccess(session, id, 'project:view')
    const access = await resolveProjectSettingsAccess(session, id)
    return access.manageMembers ? 'settings/members' : 'settings'
  })
  redirect(`/app/projects/${encodeURIComponent(id)}/${target}`)
}
