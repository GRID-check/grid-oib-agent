import { CONTACT_EMAIL } from '../consts'

/**
 * Who answers for this site, in the shape § 5 ECG and § 25 MedienG ask for.
 *
 * There is no company yet. Until the FlexCo reaches the Firmenbuch the three
 * founders are the Medieninhaber personally, and the register fields have no
 * value to carry - a sole trader who is not registered HAS no Firmenbuchnummer,
 * and without a Gewerbeberechtigung there is no chamber to name. That is why
 * they are optional rather than blank: /impressum drops the whole register
 * section while every one of them is unset, and shows it again the day one is
 * filled. Blank strings would have rendered "Firmenbuchnummer:" with nothing
 * behind it.
 *
 * Two moments change this file. When the Errichtungserklärung is signed the
 * company exists before the Firmenbuch knows it, and `legalForm` carries the
 * "in Gründung" designation from that day. When the Firmenbuch entry follows,
 * `registerNumber` and `registerCourt` get their values and the register
 * section reappears on its own; `uid` and `chamber` follow the UID and the
 * Gewerbeberechtigung whenever those arrive.
 */
export interface LegalIdentity {
  /**
   * The name of the website. A brand, not a legal entity - which is why it is
   * stated on a labelled line of its own and never inside the identity below.
   * Above the names it read as the company that does not exist yet.
   */
  operator: string
  /** Everyone who answers for the site by name - the founders, later the company. */
  mediaOwners: string[]
  /** Company name and legal form. Unset while there is no company. */
  legalForm?: string
  addressLines: string[]
  registerCourt?: string
  registerNumber?: string
  uid?: string
  /** Chamber and supervising authority (§ 5 ECG). None without a Gewerbeberechtigung. */
  chamber?: string
  email: string
}

export const legalIdentity: LegalIdentity = {
  operator: 'Piloti',
  mediaOwners: ['Jonathan Uhlemann', 'Ferdinand Rubenbauer', 'Matthias Bigl'],
  addressLines: ['Kellermanngasse 8/12', '1070 Wien, Österreich / Austria'],
  email: CONTACT_EMAIL,
}

/**
 * Who is legally responsible, as lines, in the order an Impressum states it.
 * Shared so the imprint and the privacy policy can never name a different set
 * of people: one renders the lines stacked, the other joins them into a
 * sentence. `operator` is deliberately absent - it is the medium's name, not
 * part of anyone's identity.
 */
export function identityLines(id: LegalIdentity): string[] {
  return [...id.mediaOwners, id.legalForm, ...id.addressLines].filter(
    (line): line is string => Boolean(line)
  )
}
