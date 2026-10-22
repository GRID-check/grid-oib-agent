import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { getTranslations } from '@/i18n/server'
import { InboundMailWorkspace } from '@/features/inbound-mail/components/inbound-mail-workspace'
import { loadInboundMailPage } from '../_page-data'

interface InboundMailDetailPageProps {
  params: Promise<{ id: string; mailId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('inboundMail')
  return { title: t('title') }
}

/**
 * One held mail in the E-Mail-Eingang: the list beside it on a wide screen,
 * the mail as a page of its own on a narrow one. The deep link a Postfach
 * item and a push open. A mail that is not this project's is a 404.
 */
export default async function InboundMailDetailPage({ params, searchParams }: InboundMailDetailPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id, mailId } = await params
    const data = await loadInboundMailPage(session, id, await searchParams, mailId)
    return (
      <InboundMailWorkspace
        projectId={id}
        projectName={data.projectName}
        projectClosed={data.projectClosed}
        folders={data.folders}
        status={data.status}
        outcome={data.outcome}
        initialList={data.list}
        initialListFailed={data.list === null}
        mailId={mailId}
        initialMail={data.mail}
      />
    )
  })
}
