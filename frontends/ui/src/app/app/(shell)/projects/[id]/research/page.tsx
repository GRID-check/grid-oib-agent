import { redirect } from 'next/navigation'

interface ProjectResearchPageProps {
  params: Promise<{ id: string }>
}

/**
 * Legacy research route. Research runs lived on the History page after FB-10,
 * and History itself now redirects to the chat, so this used to be two hops.
 * One hop, straight to where History lands: the route stays so old bookmarks
 * and "view report" deep links keep resolving; the project layout already
 * guards access.
 */
export default async function ProjectResearchPage({ params }: ProjectResearchPageProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${id}/chat`)
}
