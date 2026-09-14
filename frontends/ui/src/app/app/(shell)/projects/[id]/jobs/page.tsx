import { redirect } from 'next/navigation'

/**
 * Jobs moved into the Automation section, and then INTO Aufgaben: schedules
 * are the group at the top of the task list, not a tab of their own. The URL
 * keeps answering — bookmarks and old links land on the schedules view — but
 * the destination is `/automation?tab=tasks`.
 */
export default async function JobsRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${encodeURIComponent(id)}/automation?tab=tasks`)
}
