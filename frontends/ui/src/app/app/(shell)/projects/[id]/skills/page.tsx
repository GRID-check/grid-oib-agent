import { redirect } from 'next/navigation'

/**
 * Skills moved into the Automation section as a tab. The URL keeps answering —
 * bookmarks, the ⌘K palette history and old links land on the right tab — but
 * the destination is `/automation?tab=skills`.
 */
export default async function SkillsRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${encodeURIComponent(id)}/automation?tab=skills`)
}
