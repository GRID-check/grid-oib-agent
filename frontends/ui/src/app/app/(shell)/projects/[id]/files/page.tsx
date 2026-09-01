import { type Metadata } from 'next'
import { filesMetadata, renderFilesRoute } from './files-route'

interface FilesPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  return filesMetadata()
}

/** The corpus root. A level below it is `[...folder]/page.tsx`, same page. */
export default async function FilesPage({ params }: FilesPageProps): Promise<JSX.Element> {
  const { id } = await params
  return renderFilesRoute(id)
}
