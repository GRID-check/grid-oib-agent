/**
 * Shared timestamp formatting utility
 *
 * Formats Date objects or ISO string dates into a short time display (e.g. "03:35 PM").
 * Handles both Date objects and ISO string dates (from Zustand persist).
 */

export const formatTime = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
