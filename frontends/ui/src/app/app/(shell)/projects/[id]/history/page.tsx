import { redirect } from 'next/navigation'

/**
 * The History page is gone: the chat's history sheet (opened from the chat
 * toolbar) is the one record of a project's past — conversations and
 * deep-research runs both. The URL keeps answering for old bookmarks and lands
 * on the chat the sheet opens over.
 */
export default async function HistoryRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${encodeURIComponent(id)}/chat`)
}
