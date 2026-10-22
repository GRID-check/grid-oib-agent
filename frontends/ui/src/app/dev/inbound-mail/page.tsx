'use client'

/**
 * Dev preview of Dateien › E-Mail-Eingang (ADR-0134, DECISION §9): the real
 * workspace (`InboundMailWorkspace`) over the fixture client, one fixture per
 * state of the list:
 *
 * `?variant=empty|done|loading|error|one|many|thread-group|unverified-group|selected|bulk-blocked|settled|dismissed|expired|closed|followed|worst-case`
 *
 * `&mail=<id>` opens a mail beside the list (the rows link there), `&status=`
 * and `&outcome=` filter, `&locale=en` switches the language, `&chrome=0`
 * hides the variant strip for a capture. German by default, as the copy is
 * written for the German product. Not linked from anywhere; the `/dev` layout
 * 404s outside development.
 */

import type { JSX } from 'react'
import { use, useMemo } from 'react'
import { I18nProvider } from '@/i18n'
import { InboundMailWorkspace } from '@/features/inbound-mail/components/inbound-mail-workspace'
import type { InboundMailPaths } from '@/features/inbound-mail/lib/paths'
import { ADDRESS_VARIANTS, DETAIL_BY_ID, FIXTURE_NOW, FOLDERS, LIST_VARIANTS, PROJECT_ID, PROJECT_NAME, fixtureAddressClient, fixtureClient } from './fixtures'
import { DevVariantStrip } from './dev-chrome'

type SearchParams = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined)

export default function InboundMailDevPage({ searchParams }: { searchParams: Promise<SearchParams> }): JSX.Element {
  const params = use(searchParams)
  const variant = one(params.variant) && LIST_VARIANTS[one(params.variant) as string] ? (one(params.variant) as string) : 'many'
  const locale = one(params.locale) === 'en' ? 'en' : 'de'
  const fixture = LIST_VARIANTS[variant]
  const status = one(params.status) === 'handled' ? 'handled' : (fixture.status ?? 'waiting')
  const outcomeParam = one(params.outcome)
  const outcome = outcomeParam === 'filed' || outcomeParam === 'dismissed' || outcomeParam === 'expired' ? outcomeParam : (fixture.outcome ?? null)
  const mailId = one(params.mail) ?? fixture.open ?? null
  const client = useMemo(() => fixtureClient({ list: fixture }), [fixture])
  const addressClient = useMemo(
    () =>
      fixtureAddressClient(
        fixture.everReceived === false
          ? { ...(ADDRESS_VARIANTS.manager as Exclude<(typeof ADDRESS_VARIANTS)['manager'], string>), lastReceivedAt: null }
          : ADDRESS_VARIANTS.manager
      ),
    [fixture]
  )
  const paths = useMemo<InboundMailPaths>(() => {
    const base = `/dev/inbound-mail?variant=${variant}${locale === 'en' ? '&locale=en' : ''}`
    const filter = (f: { status: string; outcome: string | null }) => `${f.status !== 'waiting' ? `&status=${f.status}` : ''}${f.outcome ? `&outcome=${f.outcome}` : ''}`
    return {
      list: (f) => `${base}${filter(f)}`,
      mail: (id, f) => `${base}${filter(f)}&mail=${id}`,
      files: '/dev/files-header',
    }
  }, [variant, locale])
  const initial = mailId ? (DETAIL_BY_ID.get(mailId) ?? null) : null

  return (
    <I18nProvider initialLocale={locale} fixedLocale>
      <main className="bg-background flex h-dvh min-h-0 flex-col" data-testid="inbound-mail-preview">
        <InboundMailWorkspace
          key={`${variant}:${status}:${outcome ?? ''}:${mailId ?? ''}`}
          projectId={PROJECT_ID}
          projectName={PROJECT_NAME}
          projectClosed={fixture.closed ?? false}
          folders={FOLDERS}
          status={status}
          outcome={outcome}
          initialList={fixture.load ? null : { items: fixture.items.filter((item) => item.status === status), nextCursor: fixture.nextCursor ?? null }}
          initialListFailed={fixture.load === 'error'}
          listLoading={fixture.load === 'loading'}
          mailId={mailId}
          initialMail={initial?.view ?? null}
          initialText={initial?.text ?? null}
          client={client}
          addressClient={addressClient}
          paths={paths}
          now={FIXTURE_NOW}
          initialChecked={fixture.checked}
        />
        {one(params.chrome) !== '0' && <DevVariantStrip base="/dev/inbound-mail" variants={Object.keys(LIST_VARIANTS)} current={variant} locale={locale} />}
      </main>
    </I18nProvider>
  )
}
