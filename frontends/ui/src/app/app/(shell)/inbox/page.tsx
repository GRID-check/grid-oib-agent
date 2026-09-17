/**
 * The inbox — the hard-load arrival of the Postfach sheet (IB-1, IB-18).
 *
 * A soft navigation never reaches this page: the `(shell)/@overlay/(.)inbox`
 * interception renders the sheet above the current page instead. This page
 * serves the shareable URL, where the same sheet stands alone over the org
 * chrome and closing it lands on the projects home.
 */

import { type Metadata } from 'next'
import { getTranslations } from '@/i18n/server'
import { InboxSheet } from './inbox-sheet'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('collaboration')
  return { title: t('inbox.title') }
}

export default function InboxPage(): JSX.Element {
  return <InboxSheet standalone />
}
