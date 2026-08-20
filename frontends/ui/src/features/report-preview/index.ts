/**
 * Report preview feature
 *
 * The finished report's PDF, shown in the app on a resizable pane beside the
 * rendered markdown, instead of only as a file the reader has to download and
 * open elsewhere.
 */

export { ReportPreviewSplit } from './components/report-preview-split'
export { ReportPdfPreview } from './components/report-pdf-preview'
export {
  REPORT_BODY_WIDTH_MIN,
  REPORT_PREVIEW_WIDTH_DEFAULT,
  REPORT_PREVIEW_WIDTH_MAX,
  REPORT_PREVIEW_WIDTH_MIN,
  useReportPreviewStore,
} from './stores/report-preview-store'
export { useReportPdfPreview } from './hooks/use-report-pdf-preview'
export type { ReportPdfPreviewState, ReportPdfPreviewStatus } from './hooks/use-report-pdf-preview'
