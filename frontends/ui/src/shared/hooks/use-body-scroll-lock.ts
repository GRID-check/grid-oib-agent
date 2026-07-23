'use client'

import { useEffect } from 'react'

/**
 * Reference-counted body scroll lock. Multiple modal-like surfaces can be open
 * at once (e.g. the mobile nav drawer plus a docked panel, or two docked panels
 * both in state), so a naive per-consumer set/restore would let the first one to
 * close prematurely re-enable page scroll while another surface is still up. The
 * counter restores the original overflow only once the last locker releases, and
 * locks release in order because each consumer decrements exactly once.
 *
 * Extracted from DockedPanel so every full-screen mobile overlay shares one
 * correct implementation.
 */
let scrollLockCount = 0
let savedBodyOverflow = ''

export const lockBodyScroll = (): void => {
  if (typeof document === 'undefined') return
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLockCount += 1
}

export const releaseBodyScroll = (): void => {
  if (typeof document === 'undefined') return
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow
  }
}

/**
 * Locks background page scroll while `enabled` is true and releases it on
 * cleanup (disable/unmount). SSR-safe: the lock is applied inside an effect,
 * which never runs on the server. Idempotent per render because the effect only
 * re-runs when `enabled` flips.
 */
export function useBodyScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    lockBodyScroll()
    return () => releaseBodyScroll()
  }, [enabled])
}
