import { redirect } from 'next/navigation'

/**
 * The model page, which is now Dateien.
 *
 * The route stays as a redirect rather than being deleted, because its links
 * are not ours to break. Every agent answer that ever named a wall wrote
 * `/app/projects/:id/model?element=…` into a message that is still in the
 * database; cards, health findings and colleagues' chat messages carry the
 * same shape. Deleting the route would turn all of them into 404s — and the
 * whole point of putting a model view in a URL was that someone could send it.
 *
 * The query string is carried across verbatim, and `?model=` is what makes the
 * Dateien page open the viewer, so an old link reproduces the view it was
 * taken from rather than merely landing on the right page.
 *
 * Permanent, so a browser that has followed it once stops asking. There is no
 * plan to bring the route back — the viewer is a file preview now, not a
 * destination.
 */
interface ModelPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ModelPage({ params, searchParams }: ModelPageProps): Promise<never> {
  const [{ id }, query] = await Promise.all([params, searchParams])

  // Rebuilt rather than reused, so a repeated parameter (`?hl=…&hl=…`, which
  // is how highlight groups travel) survives the round trip. Reading them as a
  // plain object would keep only one.
  const forwarded = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const entry of value) forwarded.append(key, entry)
    else if (value !== undefined) forwarded.append(key, value)
  }

  const search = forwarded.toString()
  redirect(`/app/projects/${id}/files${search ? `?${search}` : ''}`)
}
