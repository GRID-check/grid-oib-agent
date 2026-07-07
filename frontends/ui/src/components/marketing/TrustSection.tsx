/**
 * TrustSection — the precision statement. Grid's authority comes from
 * verifiable citations to the OIB-Richtlinien and RIS, not from confident
 * prose. This section makes that promise explicit.
 */

'use client'

import { type FC } from 'react'
import { Scale, FileCheck2, Search, type LucideIcon } from 'lucide-react'
import { Stagger, StaggerItem } from '@/components/motion'
import { useTranslations } from '@/i18n'

interface Point {
  key: string
  icon: LucideIcon
}

const points: Point[] = [
  { key: 'grounded', icon: Scale },
  { key: 'traceable', icon: Search },
  { key: 'cited', icon: FileCheck2 },
]

export const TrustSection: FC = () => {
  const t = useTranslations('landing')
  return (
    <section aria-labelledby="trust-heading" className="border-y border-border bg-muted/30">
      <div className="mx-auto w-full max-w-5xl px-6 py-24 md:px-8 md:py-32">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('trust.eyebrow')}
          </p>
          <h2
            id="trust-heading"
            className="mt-4 text-3xl font-semibold tracking-tight text-foreground text-balance md:text-4xl"
          >
            {t('trust.title')}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">
            {t('trust.intro')}
          </p>
        </div>

        <Stagger inView className="mt-16 grid gap-6 md:grid-cols-3">
          {points.map(({ icon: Icon, key }) => (
            <StaggerItem
              key={key}
              className="flex flex-col rounded-2xl border border-border bg-card p-8 shadow-sm"
            >
              <span
                aria-hidden="true"
                className="flex size-9 items-center justify-center rounded-full border border-border bg-background text-primary"
              >
                <Icon className="size-4" />
              </span>
              <h3 className="mt-6 text-sm font-semibold text-foreground">
                {t(`trust.points.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {t(`trust.points.${key}.body`)}
              </p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
