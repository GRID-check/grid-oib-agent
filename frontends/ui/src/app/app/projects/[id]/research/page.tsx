import { redirect } from 'next/navigation'

interface ProjectResearchPageProps {
  params: Promise<{ id: string }>
}

/**
 * Legacy research route — research runs live on the History page now
 * (FB-10 completion, click-dummy IA spec §5). Unconditional: the standalone
 * runs page is retired regardless of flags. The route stays so old bookmarks
 * and "view report" deep links keep resolving; the project layout already
 * guards access, and History serves the same server-truth runs list.
 */
export default async function ProjectResearchPage({ params }: ProjectResearchPageProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${id}/history`)
}
