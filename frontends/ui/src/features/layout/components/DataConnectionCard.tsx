/**
 * DataConnectionCard Component
 *
 * Displays a single data connection source with enable/disable toggle.
 * Supports disabled state for unavailable sources (permission issues).
 */

'use client'

import { type FC } from 'react'
import { Globe } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import type { DataSource } from '../data-sources'

interface DataConnectionCardProps {
  /** Data source configuration */
  source: DataSource
  /** Whether the source is currently enabled */
  isEnabled: boolean
  /** Whether the source is available (user has permission). Default: true */
  isAvailable?: boolean
  /** Whether the current session is busy with operations. Default: false */
  isBusy?: boolean
  /** Custom reason for why the source is unavailable (shown in tooltip) */
  unavailableReason?: string
  /** Callback when toggle state changes */
  onToggle: (id: string, enabled: boolean) => void
}

/**
 * Card component for displaying and controlling a data connection.
 * Shows source info with toggle switch, and handles unavailable state.
 */
export const DataConnectionCard: FC<DataConnectionCardProps> = ({
  source,
  isEnabled,
  isAvailable = true,
  isBusy = false,
  unavailableReason,
  onToggle,
}) => {
  const t = useTranslations('research')
  // Combine availability and busy state
  const isDisabled = !isAvailable || isBusy

  const handleToggle = () => {
    if (!isDisabled) {
      onToggle(source.id, !isEnabled)
    }
  }

  const handleCardClick = () => {
    handleToggle()
  }

  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleToggle()
    }
  }

  const handleSwitchClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent double-toggle when clicking the switch directly
    e.stopPropagation()
  }

  return (
    <div
      role="button"
      tabIndex={isDisabled ? -1 : 0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={cn(
        'flex items-center justify-between rounded-lg border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
        isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent'
      )}
      aria-pressed={isEnabled}
      aria-disabled={isDisabled}
      aria-label={`${source.name}: ${isEnabled ? t('dataConnectionCard.enabled') : t('dataConnectionCard.disabled')}${isDisabled ? ` ${t('dataConnectionCard.disabledParenthetical')}` : ''}`}
      title={
        isBusy
          ? t('dataSources.changesDisabledBusy')
          : !isAvailable
            ? unavailableReason || t('dataConnectionCard.noPermission')
            : undefined
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
            isDisabled ? 'bg-muted/50' : 'bg-muted'
          )}
        >
          <Globe
            className={cn('h-5 w-5', isDisabled ? 'text-muted-foreground' : 'text-foreground')}
            aria-hidden="true"
          />
        </div>
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              'text-sm font-semibold',
              isDisabled ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {source.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">{source.description}</span>
        </div>
      </div>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="ml-3 flex-shrink-0" onClick={handleSwitchClick}>
        <Switch
          checked={isEnabled && isAvailable}
          onCheckedChange={handleToggle}
          disabled={isDisabled}
          aria-label={
            isDisabled
              ? t('dataConnectionCard.nameDisabled', { name: source.name })
              : isEnabled
                ? t('dataConnectionCard.disableName', { name: source.name })
                : t('dataConnectionCard.enableName', { name: source.name })
          }
        />
      </div>
    </div>
  )
}
