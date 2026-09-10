import { type Metadata } from 'next'
import { getTranslations } from '@/i18n/server'

interface WorkspaceChatLayoutProps {
  children: React.ReactNode
}

/**
 * Browser-tab title for the Büro, the same shape the project chat uses: the
 * place, then what you do there ("Büro · Piloti fragen — Piloti", the root
 * template supplying the product). The page below is a client component and
 * cannot export metadata itself; a live deep-research override
 * (`useDeepResearchTitle`) layers on top of this at runtime.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: `${t('sections.workspaceChat')} · ${t('orgHeader.askPiloti')}` }
}

export default function WorkspaceChatLayout({
  children,
}: WorkspaceChatLayoutProps): JSX.Element {
  return <>{children}</>
}
