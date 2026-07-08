/**
 * DataSourcesPanel Component
 *
 * Right-side docked panel for managing data sources and file uploads.
 * Contains two tabs: Data Connections (API sources) and File Sources (uploaded files).
 */

'use client'

import { type FC, memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Globe } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useAuth } from '@/adapters/auth'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'
import { useIsCurrentSessionBusy, useChatStore } from '@/features/chat'
import type { DataSource } from '../data-sources'
import { DataConnectionCard } from './DataConnectionCard'
import { FileSourcesTab } from './FileSourcesTab'
import { UploadOrchestrator } from '@/features/documents'
import type { DataSourcesPanelTab } from '../types'
import { DockedPanel } from './DockedPanel'

interface DataSourcesPanelProps {
  /** Callback when source enabled state changes */
  onSourceToggle?: (sourceId: string, enabled: boolean) => void
  /** Callback when a file is deleted */
  onDeleteFile?: (id: string) => void
}

/**
 * Panel for managing data sources and file uploads.
 * Opens from the right side of the screen.
 */
export const DataSourcesPanel: FC<DataSourcesPanelProps> = memo(function DataSourcesPanel({
  onSourceToggle,
  onDeleteFile,
}) {
  const { idToken, authRequired } = useAuth()
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const saveDataSourcesToConversation = useChatStore(
    (state) => state.saveDataSourcesToConversation
  )

  const isOpen = useLayoutStore((s) => s.rightPanel === 'data-sources')
  const {
    dataSourcesPanelTab,
    enabledDataSourceIds,
    availableDataSources,
    dataSourcesLoading,
    dataSourcesError,
  } = useLayoutStore(
    useShallow((s) => ({
      dataSourcesPanelTab: s.dataSourcesPanelTab,
      enabledDataSourceIds: s.enabledDataSourceIds,
      availableDataSources: s.availableDataSources,
      dataSourcesLoading: s.dataSourcesLoading,
      dataSourcesError: s.dataSourcesError,
    }))
  )

  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const setDataSourcesPanelTab = useLayoutStore((s) => s.setDataSourcesPanelTab)
  const toggleDataSource = useLayoutStore((s) => s.toggleDataSource)
  const setEnabledDataSources = useLayoutStore((s) => s.setEnabledDataSources)
  const fetchDataSources = useLayoutStore((s) => s.fetchDataSources)

  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()

  // Check if user has valid auth token
  const hasValidToken = !!idToken

  // Convert array to Set for efficient lookups
  const enabledSourcesSet = new Set(enabledDataSourceIds)

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

  // Check if any sources require authentication
  const hasAuthenticatedSources = useMemo(() => {
    return displaySources.some((source) => source.requiresAuth)
  }, [displaySources])

  const handleToggle = useCallback(
    (sourceId: string, enabled: boolean) => {
      const updatedIds = enabled
        ? [...enabledDataSourceIds, sourceId]
        : enabledDataSourceIds.filter((id) => id !== sourceId)
      toggleDataSource(sourceId)
      saveDataSourcesToConversation(updatedIds)
      onSourceToggle?.(sourceId, enabled)
    },
    [toggleDataSource, enabledDataSourceIds, saveDataSourcesToConversation, onSourceToggle]
  )

  const handleTabChange = useCallback(
    (value: string) => {
      setDataSourcesPanelTab(value as DataSourcesPanelTab)

      // Refresh files from backend when switching to the files tab
      // to detect backend-side removals (e.g. TTL cleanup)
      if (value === 'files') {
        const sessionId = useChatStore.getState().currentConversation?.id
        if (sessionId) {
          UploadOrchestrator.refreshFilesForSession(sessionId)
        }
      }
    },
    [setDataSourcesPanelTab]
  )

  // Sources are available unless they require auth and the user has no token
  const availableSources = useMemo(() => {
    return displaySources.filter((source) => !source.requiresAuth || hasValidToken)
  }, [displaySources, hasValidToken])

  // Count enabled sources from the store (only count available ones)
  const enabledAvailableCount = enabledDataSourceIds.filter((id) =>
    availableSources.some((s) => s.id === id)
  ).length
  const availableCount = availableSources.length
  const allAvailableEnabled = enabledAvailableCount === availableCount && availableCount > 0

  const handleToggleAll = useCallback(() => {
    const updatedIds = allAvailableEnabled ? [] : availableSources.map((s) => s.id)
    setEnabledDataSources(updatedIds)
    saveDataSourcesToConversation(updatedIds)
  }, [allAvailableEnabled, setEnabledDataSources, availableSources, saveDataSourcesToConversation])

  return (
    <DockedPanel
      open={isOpen}
      side="right"
      onClose={closeRightPanel}
      aria-label={t('dataSourcesPanel.title')}
      className="w-full max-w-[406px]"
      heading={
        <>
          <Globe className="h-5 w-5" aria-hidden="true" />
          <span>{t('dataSourcesPanel.title')}</span>
        </>
      }
      footer={
        dataSourcesPanelTab === 'connections' ? (
          <p className="text-xs text-muted-foreground">
            {t('dataSourcesPanel.footerConnections', {
              enabled: enabledAvailableCount,
              available: availableCount,
            })}
          </p>
        ) : (
          <p className="text-left text-xs text-muted-foreground">
            {t('dataSourcesPanel.footerFiles')}
          </p>
        )
      }
    >
      {/* Tab Navigation */}
      <Tabs value={dataSourcesPanelTab} onValueChange={handleTabChange} className="mb-4">
        <TabsList className="w-full">
          <TabsTrigger value="connections">{t('dataSourcesPanel.tabConnections')}</TabsTrigger>
          <TabsTrigger value="files">{t('dataSourcesPanel.tabFiles')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Tab Content */}
      {dataSourcesPanelTab === 'connections' ? (
        /* Data Sources Tab */
        <div className="flex flex-1 flex-col overflow-y-auto">
          {/* Auth Warning Banner - shown when authenticated sources exist but no valid token */}
          {hasAuthenticatedSources && !hasValidToken && (
            <Alert variant={!authRequired ? 'info' : 'warning'} className="mb-6">
              <AlertDescription>
                {!authRequired
                  ? t('dataSourcesPanel.enableAuthBanner')
                  : t('dataSourcesPanel.signInBanner')}
              </AlertDescription>
            </Alert>
          )}

          {/* All Connections Toggle */}
          <span className="mb-3 text-xs font-semibold uppercase text-muted-foreground">
            {t('dataSourcesPanel.allConnections')}
          </span>
          <div
            role="button"
            tabIndex={isBusy ? -1 : 0}
            onClick={isBusy ? undefined : handleToggleAll}
            onKeyDown={(e) => {
              if (!isBusy && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                handleToggleAll()
              }
            }}
            className={cn(
              'mb-4 flex items-center justify-between rounded-lg border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              isBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent'
            )}
            aria-pressed={allAvailableEnabled}
            aria-disabled={isBusy}
            aria-label={
              isBusy
                ? t('dataSourcesPanel.allAvailableDisabledOps')
                : t('dataSourcesPanel.allAvailableState', {
                    state: allAvailableEnabled
                      ? t('dataConnectionCard.enabled')
                      : t('dataConnectionCard.disabled'),
                  })
            }
            title={isBusy ? t('dataSources.changesDisabledBusy') : undefined}
          >
            <span className="text-sm font-semibold">{t('dataSourcesPanel.disableEnableAll')}</span>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div onClick={(e) => e.stopPropagation()}>
              <Switch
                checked={allAvailableEnabled}
                onCheckedChange={handleToggleAll}
                disabled={isBusy}
                aria-label={
                  isBusy
                    ? t('dataSourcesPanel.toggleAllDisabled')
                    : allAvailableEnabled
                      ? t('dataSourcesPanel.disableAll')
                      : t('dataSourcesPanel.enableAll')
                }
              />
            </div>
          </div>

          {/* Individual Connections */}
          <span className="mb-3 text-xs font-semibold uppercase text-muted-foreground">
            {t('dataSourcesPanel.individualConnections', { count: displaySources.length })}
          </span>

          {dataSourcesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner label={t('dataSources.loading')} />
            </div>
          ) : dataSourcesError ? (
            <div className="flex flex-col items-center py-4">
              <span className="mb-2 text-sm text-destructive">{t('dataSources.unableToLoad')}</span>
              <span className="mb-3 text-xs text-muted-foreground">{dataSourcesError}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchDataSources()}
                aria-label={t('dataSources.retryAria')}
              >
                {tc('actions.retry')}
              </Button>
            </div>
          ) : displaySources.length === 0 ? (
            <div className="flex flex-col items-center py-4">
              <span className="text-sm text-muted-foreground">{t('dataSources.none')}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {displaySources.map((source) => {
                const isSourceAvailable = !source.requiresAuth || hasValidToken
                return (
                  <DataConnectionCard
                    key={source.id}
                    source={source}
                    isEnabled={enabledSourcesSet.has(source.id)}
                    isAvailable={isSourceAvailable}
                    isBusy={isBusy}
                    unavailableReason={
                      !isSourceAvailable ? t('dataSourcesPanel.signInRequiredSource') : undefined
                    }
                    onToggle={handleToggle}
                  />
                )
              })}
            </div>
          )}
        </div>
      ) : (
        /* File Sources Tab */
        <FileSourcesTab onDeleteFile={onDeleteFile} />
      )}
    </DockedPanel>
  )
})
