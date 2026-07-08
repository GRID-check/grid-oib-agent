/** Shared display formatters. */

/** EUR with two decimals — the app's single money-display rule. */
export const formatEur = (value: number): string => `\u20ac${value.toFixed(2)}`
