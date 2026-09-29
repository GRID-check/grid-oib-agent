/**
 * The comparisons, in two files by kind: tools built for construction and
 * planning (vergleich-bau.ts) and general AI assistants an office already
 * has (vergleich-allgemein.ts). The hub lists them in this order.
 */
import type { LandingEntry } from '../../lib/landing'
import { vergleichBau } from './vergleich-bau'
import { vergleichAllgemein } from './vergleich-allgemein'

export const vergleich: LandingEntry[] = [...vergleichAllgemein, ...vergleichBau]
