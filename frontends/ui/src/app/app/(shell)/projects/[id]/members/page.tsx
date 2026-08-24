import { redirect } from 'next/navigation'

interface ProjectMembersPageProps {
  params: Promise<{ id: string }>
}

/**
 * Legacy members route — the roster moved into the project Settings page
 * (click-dummy IA, spec §5 / FB-9). The route stays so old links and
 * bookmarks keep working; the project layout already guards access.
 */
export default async function ProjectMembersPage({ params }: ProjectMembersPageProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${id}/settings`)
}
