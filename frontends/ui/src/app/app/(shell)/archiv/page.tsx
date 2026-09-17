/**
 * Org-wide Archiv — the hard-load arrival of the Archiv sheet (ADR-0024).
 *
 * A soft navigation never reaches this page: the `(shell)/@overlay/(.)archiv`
 * interception renders the sheet above the current page instead. This page
 * serves the shareable URL — a refresh, a pasted link — where there is no page
 * underneath to cover, so the same sheet stands alone over the org chrome and
 * closing it lands on the projects home.
 */

import { type Metadata } from 'next'
import { getTranslations } from '@/i18n/server'
import { ArchivSheet } from './archiv-sheet'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('archiv')
  return { title: t('title') }
}

export default function ArchivPage(): JSX.Element {
  return <ArchivSheet standalone />
}
