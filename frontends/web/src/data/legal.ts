import { CONTACT_EMAIL } from '../consts'

/**
 * LAUNCH BLOCKER: real company data required before going live.
 * Every value below is a placeholder and must be replaced with the actual
 * operator identity before the site is published.
 */
export interface LegalIdentity {
  operator: string
  legalForm: string
  addressLines: string[]
  registerCourt: string
  registerNumber: string
  uid: string
  email: string
}

export const legalIdentity: LegalIdentity = {
  operator: 'Piloti',
  legalForm: '[Firmenname und Rechtsform — Platzhalter / placeholder]',
  addressLines: [
    '[Straße und Hausnummer — Platzhalter / placeholder]',
    '[PLZ und Ort — Platzhalter / placeholder], Österreich / Austria',
  ],
  registerCourt: '[Firmenbuchgericht — Platzhalter / placeholder]',
  registerNumber: '[Firmenbuchnummer — Platzhalter / placeholder]',
  uid: '[UID-Nummer — Platzhalter / placeholder]',
  email: CONTACT_EMAIL,
}
