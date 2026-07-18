'use client'

import { type FC } from 'react'
import {
  Brain,
  CircleHelp,
  FileText,
  Gavel,
  Lock,
  Sparkles,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { Chip, ChipCount } from '@/components/ui/chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslations } from '@/i18n'
import { useConversationMemory } from '../hooks/use-conversation-memory'

interface MemoryNotedChipProps {
  projectId: string | null | undefined
  conversationId: string | null | undefined
}

const KIND_META: Record<string, { icon: LucideIcon; labelKey: string }> = {
  decision: { icon: Gavel, labelKey: 'memory.kinds.decision' },
  constraint: { icon: Lock, labelKey: 'memory.kinds.constraint' },
  open_question: { icon: CircleHelp, labelKey: 'memory.kinds.open_question' },
  derived_fact: { icon: FileText, labelKey: 'memory.kinds.derived_fact' },
  preference: { icon: Star, labelKey: 'memory.kinds.preference' },
}

/**
 * "Piloti noted N" — surfaces the memory items recorded during a
 * conversation turn (both the in-turn `remember` tool and the async
 * post-answer reflection stage), which otherwise land silently. Renders nothing
 * until at least one item exists.
 */
export const MemoryNotedChip: FC<MemoryNotedChipProps> = ({ projectId, conversationId }) => {
  const t = useTranslations('chat')
  const { items } = useConversationMemory(projectId, conversationId)

  /** In-turn `remember` vs the async reflection stage (provenance 'distillation'). */
  const provenanceLabel = (provenanceType: string): string =>
    provenanceType === 'distillation'
      ? t('memory.provenance.distillation')
      : t('memory.provenance.inTurn')

  if (items.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Chip asChild variant="info" size="sm" interactive aria-label={t('memory.notedAria', { count: items.length })}>
          <button type="button">
            <Brain aria-hidden="true" />
            {t('memory.noted')}
            <ChipCount>{items.length}</ChipCount>
          </button>
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Brain className="size-4 text-info" aria-hidden="true" />
          <p className="text-sm font-medium">{t('memory.addedToMemory')}</p>
        </div>
        <ul className="max-h-72 divide-y overflow-y-auto">
          {items.map((item) => {
            const meta = KIND_META[item.kind]
            const Icon = meta?.icon ?? FileText
            const label = meta ? t(meta.labelKey) : item.kind
            const fromReflection = item.provenanceType === 'distillation'
            return (
              <li key={item.id} className="flex gap-2.5 px-4 py-2.5">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug text-foreground">{item.content}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{label}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      {fromReflection && <Sparkles className="size-3" aria-hidden="true" />}
                      {provenanceLabel(item.provenanceType)}
                    </span>
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="border-t px-4 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t('memory.manageHint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
