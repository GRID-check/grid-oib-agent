/**
 * One folder of the project corpus — `/app/projects/<id>/files/Pläne/EG`.
 *
 * A folder is a place, so it has an address: back walks up a level instead of
 * out of Dateien, a level can be sent to a colleague, and a reload lands where
 * the reader was. The segments are folder NAMES (see
 * `features/documents/lib/folder-url.ts` for why that is safe), and the
 * workspace resolves them against the folder listing it already loads — a path
 * that names nothing redirects back to the corpus root.
 */

import { type Metadata } from 'next'
import { filesMetadata, renderFilesRoute } from '../files-route'

interface FolderPageProps {
  params: Promise<{ id: string; folder: string[] }>
}

export async function generateMetadata({ params }: FolderPageProps): Promise<Metadata> {
  const { folder } = await params
  return filesMetadata(folder)
}

export default async function FilesFolderPage({ params }: FolderPageProps): Promise<JSX.Element> {
  const { id, folder } = await params
  return renderFilesRoute(id, folder)
}
