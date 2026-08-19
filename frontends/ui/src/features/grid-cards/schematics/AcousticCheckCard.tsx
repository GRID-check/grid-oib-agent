/**
 * AcousticCheckCard — OIB 5 Schallschutz: direction-aware dB gauges.
 *
 * One LimitBar gauge per building-part pair. The two metric families read in
 * opposite directions — airborne DnTw / Rw_res are HIGHER-is-better (≥),
 * impact LnTw is LOWER-is-better (≤) — so each gauge carries an explicit
 * direction annotation ("↑ höher ist besser" / "↓ niedriger ist besser") and
 * the renderer-computed margin against the limit ("Reserve +3 dB" /
 * "Fehlbetrag 2 dB"), making the good direction unmistakable without a
 * mirrored axis. References are grounded per check: the first reference feeds
 * the NormRefFooter, rows citing a different source show it inline. Unknown
 * measured values read "fehlende Angabe", never a guessed number.
 */

import { type FC } from 'react'
import { Volume2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslations, type Translator } from '@/i18n'
import { fmtNum, LimitBar, SchematicCard, statusColor, worstStatus } from './kit'
import type { AcousticCheckItemData, AcousticMetric, DimensionCheckData } from './types'

interface AcousticCheckCardProps {
  title: string
  checks: AcousticCheckItemData[]
  sound_class?: string | null
  note?: string | null
}

const METRIC_INFO: Record<
  AcousticMetric,
  { label: string; kind: (t: Translator) => string; lowerBetter: boolean }
> = {
  DnTw: {
    label: 'DnT,w',
    kind: (t) => t('cards.schematics.acoustic.airborne'),
    lowerBetter: false,
  },
  LnTw: { label: 'LnT,w', kind: (t) => t('cards.schematics.acoustic.impact'), lowerBetter: true },
  Rw_res: {
    label: 'Rw,res',
    kind: (t) => t('cards.schematics.acoustic.airborneResultant'),
    lowerBetter: false,
  },
}

export const AcousticCheckCard: FC<AcousticCheckCardProps> = ({
  title,
  checks,
  sound_class,
  note,
}) => {
  const t = useTranslations('chat')
  const footerRef = checks[0]?.reference ?? null

  return (
    <SchematicCard
      icon={Volume2}
      title={title}
      verdict={worstStatus(checks.map((c) => c.check.status))}
      note={note}
      reference={footerRef}
    >
      {sound_class && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('cards.schematics.acoustic.soundClass')}</span>
          <Badge variant="outline" className="font-mono text-xs font-normal">
            {sound_class}
          </Badge>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {checks.map((item, index) => {
          const info = METRIC_INFO[item.metric]
          const comparator = item.check.comparator ?? (info.lowerBetter ? '<=' : '>=')
          const gauge: DimensionCheckData = {
            ...item.check,
            label: `${info.label} · ${info.kind(t)}`,
            unit: item.check.unit ?? 'dB',
            comparator,
          }
          // Margin against the limit is arithmetic on provided data, oriented
          // so positive always means "on the safe side of the limit".
          const margin =
            gauge.value != null && gauge.required != null
              ? comparator === '<='
                ? gauge.required - gauge.value
                : gauge.value - gauge.required
              : null
          const differentRef =
            footerRef &&
            (item.reference.document !== footerRef.document ||
              item.reference.section !== footerRef.section)

          return (
            <div key={`${item.path_label}-${index}`} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {item.path_label}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {info.lowerBetter
                    ? t('cards.schematics.acoustic.lowerIsBetter')
                    : t('cards.schematics.acoustic.higherIsBetter')}
                </span>
              </div>
              <LimitBar check={gauge} />
              <div className="flex items-baseline justify-between gap-3 text-xs">
                {margin != null ? (
                  <span className="font-mono" style={{ color: statusColor(gauge.status) }}>
                    {margin >= 0
                      ? t('cards.schematics.acoustic.reserve', { margin: fmtNum(margin) })
                      : t('cards.schematics.acoustic.shortfall', {
                          margin: fmtNum(Math.abs(margin)),
                        })}
                  </span>
                ) : (
                  <span />
                )}
                {differentRef && (
                  <span className="text-muted-foreground">
                    {item.reference.document}
                    {item.reference.section ? ` · ${item.reference.section}` : ''}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </SchematicCard>
  )
}
