/**
 * Context-chip helpers for the Herleitung basis footer — the enabled data
 * sources + attached files a query ran against, shown as clean pills.
 */

import type { Translator } from '@/i18n'

/** Data source ID → display name. */
export const formatDataSourceName = (sourceId: string, t: Translator): string => {
  if (sourceId === 'web_search') return t('thinking.dataSource.webSearch')
  if (sourceId === 'knowledge_layer') return t('thinking.dataSource.knowledgeBase')
  if (sourceId === 'ris') return t('thinking.dataSource.ris')
  return sourceId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/** Enabled data sources + files → the ordered chip label list. */
export const buildContextChips = (
  enabledDataSources: string[],
  messageFiles: Array<{ id: string; fileName: string }>,
  t: Translator
): string[] => [
  ...enabledDataSources.map((s) => formatDataSourceName(s, t)),
  ...messageFiles.map((f) => f.fileName),
]
