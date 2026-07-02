// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    missingInfo?: Array<{ label: string; description: string }>
  } | null
  documentCount: number
  totalFileSize: number
  recentDocuments: OverviewDocument[]
}
