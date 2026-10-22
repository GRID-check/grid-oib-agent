'use client'

/**
 * How far a mail's sender is confirmed, as one line: a glyph, the words, and
 * (in the detail) a toggletip that says what the words mean. Glyph and words
 * always travel together; there is no colour that says it alone.
 *
 * Restraint is the point. A confirmed domain is a quiet fact in muted ink,
 * not a green badge: chroma in this product is provenance. Only the two
 * cases a person must not miss before filing, a member's address without
 * their domain's signature and someone posing as a member, wear the warning
 * tint, because filing them needs the person's explicit yes.
 */

import type { JSX } from 'react'
import { Info, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { Toggletip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import type { InboundMailSenderView } from '@/lib/inbound-mail/inbound-mail-wire'
import type { InboundSenderTrust, SenderFlag } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { cn } from '@/lib/utils'
import { senderFlagLines, senderTone, senderTrustLine, type SenderTrustLine } from '../lib/sender'

const KEY: Record<SenderTrustLine['kind'], string> = {
  verified: 'verified',
  bcc_own: 'bccOwn',
  member_unverified: 'memberUnverified',
  impersonation: 'impersonation',
  unverified: 'unverified',
}

export function useTrustLabel(): (line: SenderTrustLine) => string {
  const t = useTranslations('inboundMail')
  return (line) => {
    switch (line.kind) {
      case 'verified':
        return t('trust.verified', { domain: line.domain })
      case 'bcc_own':
        return t('trust.bccOwn')
      case 'impersonation':
        return t('trust.impersonation', { name: line.name })
      case 'member_unverified':
        return t('trust.memberUnverified')
      case 'unverified':
        return t('trust.unverified')
    }
  }
}

function TrustGlyph({ line, className }: { line: SenderTrustLine; className?: string }): JSX.Element {
  const tone = senderTone(line)
  const Icon = tone === 'confirmed' ? ShieldCheck : tone === 'warning' ? ShieldAlert : ShieldQuestion
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
}

/**
 * The row's glyph: shown only when the sender is not confirmed, with the label
 * as its accessible name. A list row knows the trust and the flags, not the
 * DKIM reason, so it says „Mitglied · Domain nicht bestätigt“ where the detail
 * may say more.
 */
export function SenderTrustGlyph({ trust, flags }: { trust: InboundSenderTrust | null; flags: SenderFlag[] }): JSX.Element | null {
  const label = useTrustLabel()
  const verified = trust === 'member_verified' || trust === 'external_verified'
  const line = senderTrustLine({
    trust: trust ?? 'external_unverified',
    reason: verified ? 'dkim_pass' : 'dkim_none',
    flags,
    name: null,
    address: '',
    domain: null,
    signerDomain: null,
  })
  const tone = senderTone(line)
  if (tone === 'confirmed') return null
  return (
    <span
      role="img"
      aria-label={label(line)}
      title={label(line)}
      data-testid="sender-trust-glyph"
      data-tone={tone}
      className={cn('inline-flex shrink-0', tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}
    >
      <TrustGlyph line={line} />
    </span>
  )
}

/** The detail's trust line, its flags under it, each a fact with its glyph; the explanation behind an info toggletip. */
export function SenderTrustLines({ sender }: { sender: InboundMailSenderView }): JSX.Element {
  const t = useTranslations('inboundMail')
  const label = useTrustLabel()
  const line = senderTrustLine(sender)
  const tone = senderTone(line)
  const flags = senderFlagLines(sender)
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="sender-trust">
      <p
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          // Gold on the glyph, ink on the words: the warning tone is under 4.5:1 as 12px text.
          tone === 'warning' ? 'text-foreground font-medium [&>svg:first-child]:text-warning' : tone === 'confirmed' ? 'text-foreground' : 'text-muted-foreground'
        )}
        data-tone={tone}
      >
        <TrustGlyph line={line} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{label(line)}</span>
        <Toggletip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground touch-target inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-label={t(`trust.explain.${KEY[line.kind]}`)}
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{t(`trust.explain.${KEY[line.kind]}`)}</TooltipContent>
        </Toggletip>
      </p>
      {flags.map((flag) => (
        <p key={flag} className="text-foreground flex items-center gap-1.5 font-medium" data-testid={`sender-flag-${flag}`}>
          <ShieldAlert className="text-warning size-3.5 shrink-0" aria-hidden />
          <span>{t(`flags.${flag}`)}</span>
        </p>
      ))}
    </div>
  )
}
