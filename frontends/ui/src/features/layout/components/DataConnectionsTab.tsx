/**
 * DataConnectionsTab Component
 *
 * Tab displaying all available data connection sources (e.g., web search, knowledge base, document store).
 * Each source can be enabled/disabled for the current session.
 * Sources are fetched from the Data Sources API on mount.
 */

'use client'

import { type FC, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { type DataSource } from '../data-sources'
import { DataConnectionCard } from './DataConnectionCard'
import { useLayoutStore } from '../store'

interface DataConnectionsTabProps {
  /** Set of enabled source IDs */
  enabledSourceIds: Set<string>
  /** Callback when source toggle state changes */
  onToggle: (sourceId: string, enabled: boolean) => void
}

/**
 * Tab content for managing data connections.
 * Displays available data sources with enable/disable toggles.
 */
export const DataConnectionsTab: FC<DataConnectionsTabProps> = ({ enabledSourceIds, onToggle }) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const { availableDataSources, dataSourcesLoading, dataSourcesError } = useLayoutStore(
    useShallow((s) => ({
      availableDataSources: s.availableDataSources,
      dataSourcesLoading: s.dataSourcesLoading,
      dataSourcesError: s.dataSourcesError,
    }))
  )
  const fetchDataSources = useLayoutStore((s) => s.fetchDataSources)

  // Convert API data sources to UI format - no fallback
  const displaySources: DataSource[] = useMemo(() => {
    if (!availableDataSources || availableDataSources.length === 0) {
      return []
    }
    return availableDataSources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description ?? '',
      category: source.category ?? 'enterprise',
      defaultEnabled: true,
      requiresAuth: source.requires_auth ?? false,
    }))
  }, [availableDataSources])

  if (dataSourcesLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <Spinner label={t('dataSources.loading')} />
        <span className="mt-2 text-sm text-muted-foreground">{t('dataSources.loadingEllipsis')}</span>
      </div>
    )
  }

  // Show error state when API fails - no fallback to hardcoded sources
  if (dataSourcesError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-8">
        <span className="mb-2 text-sm text-destructive">{t('dataSources.unableToLoad')}</span>
        <span className="mb-4 text-center text-xs text-muted-foreground">{dataSourcesError}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchDataSources()}
          aria-label={t('dataSources.retryAria')}
        >
          {tc('actions.retry')}
        </Button>
      </div>
    )
  }

  // Show empty state if no sources available
  if (displaySources.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-8">
        <span className="text-sm text-muted-foreground">{t('dataSources.none')}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <span className="mb-3 text-xs font-semibold uppercase text-muted-foreground">
        {t('dataConnectionsTab.availableSources', { count: displaySources.length })}
      </span>

      <div className="flex flex-col gap-2">
        {displaySources.map((source) => (
          <DataConnectionCard
            key={source.id}
            source={source}
            isEnabled={enabledSourceIds.has(source.id)}
            isAvailable={true}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  )
}
