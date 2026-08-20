/**
 * The value model behind the ROI section (`Wertrechner.astro`).
 *
 * It lives here, not in the component, because it is arithmetic rather than
 * markup: the section renders it once on the server for the default office and
 * `scripts/roi.ts` recomputes it on every slider move — one implementation, so
 * the two can never disagree.
 *
 * The split between what is fixed and what the visitor sets is deliberate and
 * is the whole honesty of the section. The constants below are *our* claims and
 * are stated as such; the inputs are the visitor's own office, which we cannot
 * know and do not pretend to. A claim is not a dial — a slider under "how much
 * time does Piloti give back?" would invite the visitor to author our promise,
 * and whatever number they landed on would be worth nothing to them.
 */

/** Hours in the nominal work week the calculator reasons about. */
export const WEEK_HOURS = 40

/**
 * Paid weeks actually worked per year: 52 minus five weeks of statutory leave
 * (25 Urlaubstage) and roughly thirteen Austrian public holidays. It sets the
 * hourly rate and the hours read-out, but not the money: the working year
 * cancels out of `valuePerSeat`, so the euro result holds whatever a firm's
 * real calendar looks like.
 */
export const WORK_WEEKS = 44

/** Hours per person per year — the divisor turning a salary into an hourly cost. */
export const HOURS_PER_YEAR = WEEK_HOURS * WORK_WEEKS

/** Our claim: the share of a planner's week that goes to looking things up. */
export const RESEARCH_SHARE = 0.3

/** Our claim: the share of that research time Piloti gives back. */
export const TIME_SAVED = 0.4

/** List price of one Piloti seat, € per month. */
export const SEAT_COST_MONTHLY = 120

/** What the visitor sets, because it is theirs and we cannot know it. */
export interface RoiInputs {
  /** People in the office who get a seat. */
  seats: number
  /** Median gross salary of one of those people, € per year. */
  salary: number
}

export interface RoiResult {
  /** Hours one person gets back in a working week. */
  hoursPerWeek: number
  /** Hours the whole team gets back in a year. */
  hoursPerYear: number
  /** Those hours expressed as full-time positions. */
  fte: number
  /** Cost of one person's hour, gross salary only. */
  hourlyCost: number
  /** Value of the hours one seat gives back, € per year. */
  valuePerSeat: number
  /** Value of the hours the team gives back, € per year. */
  grossValue: number
  /** What the seats cost, € per year. */
  licenceCost: number
  /** Value minus licence cost, € per year. */
  netValue: number
  /** Gross value per euro of licence cost. */
  returnFactor: number
  /** Months until the recovered time has paid for the seats. */
  paybackMonths: number
}

export const ROI_DEFAULTS: RoiInputs = {
  seats: 10,
  salary: 50_000,
}

/**
 * Value of the time Piloti gives back, against what the seats cost.
 *
 * The chain is: a share of the week goes to research, a share of that comes
 * back, and the hours that come back are worth what the office pays for them.
 * Note that the hourly rate uses the *gross* salary — employer on-costs
 * (Lohnnebenkosten, roughly +30 % in Austria) are left out, so the figure is
 * the conservative end of the range rather than the flattering one.
 */
export function computeRoi({ seats, salary }: RoiInputs): RoiResult {
  const hoursPerWeek = WEEK_HOURS * RESEARCH_SHARE * TIME_SAVED
  const hoursPerYear = hoursPerWeek * WORK_WEEKS * seats
  const hourlyCost = salary / HOURS_PER_YEAR

  // Equivalently `salary * RESEARCH_SHARE * TIME_SAVED` — the working year
  // cancels out, which is why an office with a different one still gets a fair
  // answer out of this.
  const valuePerSeat = hoursPerWeek * WORK_WEEKS * hourlyCost
  const grossValue = valuePerSeat * seats
  const licenceCost = seats * SEAT_COST_MONTHLY * 12

  return {
    hoursPerWeek,
    hoursPerYear,
    fte: hoursPerYear / HOURS_PER_YEAR,
    hourlyCost,
    valuePerSeat,
    grossValue,
    licenceCost,
    netValue: grossValue - licenceCost,
    returnFactor: licenceCost > 0 ? grossValue / licenceCost : 0,
    // Guarded rather than assumed: a visitor can drag the sliders to a world in
    // which nothing is saved, and `0/0` must not reach the page as "NaN months".
    paybackMonths: grossValue > 0 ? (licenceCost / grossValue) * 12 : Infinity,
  }
}
