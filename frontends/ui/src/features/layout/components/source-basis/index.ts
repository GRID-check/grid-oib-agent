/** Datenbasis — the composer's "where may Piloti look" control. */
export { SourceBasisTrigger, type SourceBasisTriggerProps } from './SourceBasisTrigger'
export { SourceBasisPicker, useSourceCategoryLabels } from './SourceBasisPicker'
export { SourceBasisRow, type SourceBasisRowProps } from './SourceBasisRow'
export {
  buildSourceCategories,
  summariseCategories,
  selectionFromCategories,
  wireForSelection,
  KNOWLEDGE_LAYER_ID,
  CATEGORY_ORDER,
  CATEGORY_SIGNAL,
  MAX_TRIGGER_CATEGORIES,
  type SourceCategory,
  type SourceCategoryId,
  type SourceCategoryLabels,
  type SourceBasisState,
  type CategorySelection,
  type BuildSourceCategoriesInput,
  type BasisSummary,
  type BasisSummaryKind,
} from './source-basis-model'
