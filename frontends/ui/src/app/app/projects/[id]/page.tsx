import { redirect } from 'next/navigation'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

/**
 * Project root — Chat is the project landing surface (click-dummy IA, spec §5).
 * The old Overview content lives on the Settings page now; auth/access is
 * already enforced by the project layout wrapping this route.
 */
export default async function ProjectPage({ params }: ProjectPageProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${id}/chat`)
}
