'use client'

/**
 * WHICH KNOWLEDGE LEVELS this turn read — law → office → register →
 * project(s) → conversation → web (`workspace-chat-ui.md` §4).
 *
 * A band under the fan, not a second panel, and deliberately not a second list
 * of the same documents. The fan already names every document it found; what it
 * cannot say, because it is organised by lane, is *which levels were not read at
 * all*. That is the one thing this band adds, so that is all it renders: the six
 * levels in fixed authority order, each with how much came from it.
 *
 * ## Every level renders, including the empty ones
 *
 * An absent level is drawn in `--source-auto` gray with "nichts eingeblendet",
 * the Lücke treatment the design language reserves for honest absence (§3,
 * failure mode 1). This is the whole point of the band. A reader in the Büro
 * asking a Baurecht question can see that Projektwissen was NOT read, and a
 * reader whose question needed a project can see the hole where it should have
 * been — neither of which is visible in a fan that only draws what it found.
 *
 * ## One subgroup per project
 *
 * In the Büro several mounted projects are readable in one turn, so "Projekt ·
 * 6" would have merged exactly the distinction the mount list exists to keep. A
 * project-shelf hit whose project the wire did not name is counted in the level
 * but sits in its own unattributed subgroup rather than being assigned to the
 * likeliest one.
 *
 * ## Not the LangGraph topology
 *
 * The graph answers "which node ran" and changes when the agent is re-shaped;
 * this answers "which knowledge level was read", which is the question the
 * ScopeChip and the ScopeTree already promised an answer to. Langfuse keeps the
 * graph, for the people who need it.
 */

import { type FC } from 'react'
import { CircleSlash } from 'lucide-react'

import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { cn } from '@/lib/utils'
import type { LevelGroup } from '../../lib/herleitung-levels'
import { LEVEL_SIGNAL } from '../../lib/herleitung-levels'

export interface HerleitungLevelsProps {
  groups: readonly LevelGroup[]
}

export const HerleitungLevels: FC<HerleitungLevelsProps> = ({ groups }) => {
  const t = useTranslations('chat')

  return (
    <section className="flex flex-col gap-1.5" data-testid="herleitung-levels">
      <SectionLabel as="h3">{t('workspace.tree.title')}</SectionLabel>
      <ul className="flex flex-col gap-1">
        {groups.map((group) => {
          const empty = group.hitCount === 0
          return (
            <li
              key={group.level}
              className={cn('flex flex-wrap items-center gap-2', empty && 'opacity-70')}
              data-testid={`herleitung-level-${group.level}`}
              data-empty={empty ? 'true' : 'false'}
            >
              {/* Gray AND saying it is empty: on this surface colour is never
                  the only carrier of a state. */}
              {empty ? (
                <SourceSignalChip signal="auto" icon={CircleSlash}>
                  {t(`workspace.herleitung.levels.${group.level}`)}
                </SourceSignalChip>
              ) : (
                <SourceSignalChip signal={LEVEL_SIGNAL[group.level]}>
                  {t(`workspace.herleitung.levels.${group.level}`)}
                </SourceSignalChip>
              )}

              {empty ? (
                <span className="text-muted-foreground text-xs">
                  {t('workspace.herleitung.levelEmpty')}
                </span>
              ) : group.level === 'project' && group.projects.some((sub) => sub.projectName) ? (
                // Per project, because one number across two projects is exactly
                // the distinction the mount list exists to keep. Only where the
                // wire NAMED one, though: a lone unattributed subgroup would
                // repeat the level's own label back at it ("Projekt · Projekt
                // 1") and say nothing the count does not.
                group.projects.map((sub) => (
                  <SourceSignalChip
                    key={sub.projectId ?? '__unattributed__'}
                    signal="project"
                    iconless
                    className="max-w-56 gap-1.5 pr-2.5"
                    trailing={<span className="tabular-nums opacity-80">{sub.entries.length}</span>}
                  >
                    {sub.projectName
                      ? t('workspace.attribution.project', { project: sub.projectName })
                      : t('workspace.herleitung.levels.project')}
                  </SourceSignalChip>
                ))
              ) : (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t('workspace.herleitung.levelCount', { docs: group.hitCount })}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
