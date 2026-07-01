// AUTO-GENERATED from shared/cards/schemas.json — do not edit; run `npm run generate:cards`
// SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod'

export const summaryCardSchema = z.object({ "content": z.union([z.string(), z.null()]).describe("One-paragraph summary").default(null), "key_points": z.union([z.array(z.string()), z.null()]).describe("Bullet points highlighting key facts").default(null), "title": z.string().min(1).describe("Short title for the summary card"), "type": z.literal("summary") }).describe("A concise overview of the answer for the user.")

export const legalBasisCardSchema = z.object({ "article": z.union([z.string(), z.null()]).describe("Relevant article or paragraph number").default(null), "law": z.string().min(1).describe("Name of the law, regulation, or OIB Richtlinie"), "original_text": z.union([z.string(), z.null()]).describe("Literal excerpt from the source, if available").default(null), "section": z.union([z.string(), z.null()]).describe("Relevant section or chapter").default(null), "summary": z.union([z.string(), z.null()]).describe("Plain-language summary of the legal relevance").default(null), "type": z.literal("legal_basis") }).describe("A legal norm, regulation, or OIB Richtlinie that grounds the answer.")

export const gridCardSchema = z.discriminatedUnion('type', [
  summaryCardSchema,
  legalBasisCardSchema,
])
