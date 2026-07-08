import type { ApplicableStandard } from '@/lib/oib/applicable-standards'
import type { ProjectProfile } from '@/lib/project-profile/types'

export interface OverviewDocument {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string | null
  createdAt: Date
}

export interface ProjectOverviewData {
  id: string
  name: string
  collectionName: string
  createdAt: string
  profileDisplay: {
    title?: string
    summary?: string
    keyFacts?: Array<{ label: string; value: string }>
    missingInfo?: string[]
  } | null
  /** Raw structured profile — the brief fact sheet is derived from this at render time. */
  profile: ProjectProfile | null
  applicableStandards: ApplicableStandard[]
  briefComplete: boolean
  documentCount: number
  totalFileSize: number
  recentDocuments: OverviewDocument[]
}
