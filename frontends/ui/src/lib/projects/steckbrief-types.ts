/**
 * The Steckbrief's wire shapes (ADR-0089), shared by the routes, the service
 * and the form. Isomorphic: no I/O.
 */

import { z } from 'zod'
import { isMonth, isOrderedPeriod, type Month } from './month'

const monthField = z
  .string()
  .refine(isMonth, { message: 'Expected a month as YYYY-MM' })
  .transform((value) => value as Month)
  .nullable()

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()

/** A period that runs forwards: Abschluss not before Beginn. */
export const projectPeriodSchema = z
  .object({ startedOn: monthField, endedOn: monthField })
  .refine((period) => isOrderedPeriod(period.startedOn, period.endedOn), {
    message: 'The end lies before the start',
    path: ['endedOn'],
  })
export type ProjectPeriodInput = z.infer<typeof projectPeriodSchema>

/**
 * One person on the project. Name, Funktion, Firma, von–bis and an optional
 * Piloti account: deliberately nothing else (GDPR Art. 5(1)(c)), no e-mail and
 * no phone.
 */
export const projectPersonSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    function: optionalText(200),
    company: optionalText(200),
    startedOn: monthField,
    endedOn: monthField,
    userId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict()
  .refine((person) => isOrderedPeriod(person.startedOn, person.endedOn), {
    message: 'The end lies before the start',
    path: ['endedOn'],
  })
export type ProjectPersonInput = z.infer<typeof projectPersonSchema>

export interface ProjectPersonView {
  id: string
  name: string
  function: string | null
  company: string | null
  startedOn: Month | null
  endedOn: Month | null
  /** The linked Piloti account, named as the directory knows it; null when none or no longer in the organization. */
  account: { userId: string; name: string } | null
}

export interface SteckbriefView {
  /** The profile fact „Adresse / Gemeinde" (`standort_adresse`); edited in the intake wizard. */
  address: string | null
  startedOn: Month | null
  endedOn: Month | null
  people: ProjectPersonView[]
  /** Whether the reader may change the period and the people: false in a closed project. */
  canEdit: boolean
  /** Whether the reader may delete a person: also in a closed project, for whoever manages it (erasure). */
  canErase: boolean
}
