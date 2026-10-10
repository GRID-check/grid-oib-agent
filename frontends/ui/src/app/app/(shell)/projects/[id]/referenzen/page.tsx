import { redirect } from 'next/navigation'

interface ReferencesRedirectProps {
  params: Promise<{ id: string }>
}

/**
 * Similar projects moved into the project hub: a tile on its Overview and a
 * section behind it. The route stays as a redirect because chat answers and
 * bookmarks already carry `/referenzen`; the project layout guards access.
 */
export default async function ReferencesRedirect({
  params,
}: ReferencesRedirectProps): Promise<never> {
  const { id } = await params
  redirect(`/app/projects/${encodeURIComponent(id)}/settings/references`)
}
