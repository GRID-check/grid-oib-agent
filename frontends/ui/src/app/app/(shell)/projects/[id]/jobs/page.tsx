import { redirect } from 'next/navigation'

/**
 * Jobs moved into the Automation section as a tab. The URL keeps answering —
 * bookmarks and old links land on the right tab — but the destination is
 * `/automation?tab=jobs`.
 */
export default async function JobsRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${encodeURIComponent(id)}/automation?tab=jobs`)
}
