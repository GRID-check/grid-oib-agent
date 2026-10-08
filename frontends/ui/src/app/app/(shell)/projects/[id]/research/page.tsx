import { redirect } from 'next/navigation'

interface ProjectResearchPageProps {
  params: Promise<{ id: string }>
}

/**
 * Legacy research route. Research runs live in the project chat, so this
 * redirects straight there. The route stays so old bookmarks and "view report"
 * deep links keep resolving; the project layout already guards access.
 */
export default async function ProjectResearchPage({ params }: ProjectResearchPageProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${id}/chat`)
}
