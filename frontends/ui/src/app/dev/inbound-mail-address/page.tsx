'use client'

/**
 * Dev preview of the project's mail address (ADR-0134): the settings card
 * (`InboundMailAddressCard`, Settings › Dokumente) and the dialog the upload
 * menu's „Per E-Mail senden …“ opens (`InboundMailAddressDialog`, with
 * `&dialog=1`), over the fixture address client:
 *
 * `?variant=manager|member|off|off-member|unavailable|long-address|loading|error|refusals|own-dkim-missing`
 *
 * The manager's buttons work against the fixture (replace, switch off,
 * create). `&locale=en`, `&chrome=0` as on `/dev/inbound-mail`. Not linked
 * from anywhere; the `/dev` layout 404s outside development.
 */

import type { JSX } from 'react'
import { use, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { I18nProvider } from '@/i18n'
import { InboundMailAddressCard, InboundMailAddressDialog } from '@/features/inbound-mail/components/inbound-mail-address'
import { ADDRESS_VARIANTS, PROJECT_ID, PROJECT_NAME, fixtureAddressClient } from '../inbound-mail/fixtures'
import { DevVariantStrip } from '../inbound-mail/dev-chrome'

type SearchParams = Record<string, string | string[] | undefined>

export default function InboundMailAddressDevPage({ searchParams }: { searchParams: Promise<SearchParams> }): JSX.Element {
  const params = use(searchParams)
  const requested = typeof params.variant === 'string' ? params.variant : ''
  const variant = requested in ADDRESS_VARIANTS ? requested : 'manager'
  const locale = params.locale === 'en' ? 'en' : 'de'
  const [open, setOpen] = useState(params.dialog === '1')
  const cardClient = useMemo(() => fixtureAddressClient(ADDRESS_VARIANTS[variant]), [variant])
  const dialogClient = useMemo(() => fixtureAddressClient(ADDRESS_VARIANTS[variant]), [variant])
  return (
    <I18nProvider initialLocale={locale} fixedLocale>
      <main className="bg-background min-h-dvh px-4 py-8 md:px-8" data-testid="inbound-mail-address-preview">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
            Per E-Mail senden …
          </Button>
          <InboundMailAddressCard key={variant} projectId={PROJECT_ID} projectName={PROJECT_NAME} client={cardClient} />
        </div>
        <InboundMailAddressDialog projectId={PROJECT_ID} projectName={PROJECT_NAME} open={open} onOpenChange={setOpen} client={dialogClient} />
        {params.chrome !== '0' && <DevVariantStrip base="/dev/inbound-mail-address" variants={Object.keys(ADDRESS_VARIANTS)} current={variant} locale={locale} />}
      </main>
    </I18nProvider>
  )
}
