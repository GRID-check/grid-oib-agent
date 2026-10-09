'use client'

/**
 * What a mail to a project address did NOT file, under its inbox row.
 *
 * The row's title says how many files landed. A sender whose drawing did not
 * arrive needs the name and the reason, or they will send it again and get
 * the same answer: so each skipped file is listed with a reason label, up to
 * the ten the notification carries, and "+N more" for the rest. When nothing
 * was filed at all, one more line says what the sender most often expected to
 * work: a link to a cloud file is not an attachment, and nothing fetches it.
 *
 * Drawn from the row's typed params (`INBOX_PARAMS_SCHEMAS` in
 * `lib/inbox/registry.ts`), so it renders only what the schema admitted.
 */

import type { JSX } from 'react'
import { useTranslations } from '@/i18n'
import type { InboundMailFiledParams } from '@/lib/inbox/types'
import type { SkipReason } from '@/lib/inbound-mail/types'

/** Dictionary leaf per reason; exhaustive, so a new reason fails `tsc` here. */
const REASON_KEYS: Record<SkipReason, string> = {
  embedded: 'embedded',
  tnef: 'tnef',
  signature: 'signature',
  encrypted: 'encrypted',
  calendar: 'calendar',
  empty: 'empty',
  'unknown-type': 'unknownType',
  limit: 'limit',
  type: 'type',
  size: 'size',
  screened: 'screened',
  quota: 'quota',
}

const KEY = 'inbox.types.inboundMailFiled'

export function InboundMailSkippedFiles({
  params,
}: {
  params: InboundMailFiledParams
}): JSX.Element | null {
  const t = useTranslations('collaboration')
  const { filed, skipped, skippedFiles } = params
  const more = Math.max(0, skipped - skippedFiles.length)
  const nothingFiled = filed === 0

  if (skipped === 0 && !nothingFiled) return null

  return (
    <div className="text-muted-foreground mt-1 space-y-1 text-xs" data-testid="inbox-mail-skipped">
      {skipped > 0 && (
        <>
          <p>{t(`${KEY}.skippedLabel`)}</p>
          <ul className="space-y-0.5">
            {skippedFiles.map((file, index) => (
              <li key={`${index}-${file.name}`} className="flex min-w-0 gap-1">
                <span className="text-foreground/80 min-w-0 truncate font-medium" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0">– {t(`${KEY}.reasons.${REASON_KEYS[file.reason]}`)}</span>
              </li>
            ))}
            {more > 0 && <li>{t(`${KEY}.more`, { count: more })}</li>}
          </ul>
        </>
      )}
      {nothingFiled && <p>{t(`${KEY}.cloudLinks`)}</p>}
    </div>
  )
}
