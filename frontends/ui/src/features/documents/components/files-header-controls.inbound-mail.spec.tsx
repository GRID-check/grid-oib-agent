/**
 * The Dateien header's way into the E-Mail-Eingang: a ghost link with the
 * muted count on a wide screen (the label carries the number), an entry in
 * the ⋯ on a phone with the count as its hint, and nothing for a reader who
 * may not decide held mail.
 */

import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files',
  useSearchParams: () => new URLSearchParams(),
}))

import { render, screen } from '@/test-utils'
import { FilesHeaderControls, type FilesHeaderControlsProps } from './files-header-controls'

const props = (overrides: Partial<FilesHeaderControlsProps> = {}): FilesHeaderControlsProps => ({
  phone: false,
  view: 'cards',
  onViewChange: vi.fn(),
  renderFilter: () => null,
  search: { value: '', onChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn() },
  ...overrides,
})

describe('FilesHeaderControls › E-Mail-Eingang', () => {
  it('links with the muted count, the number in its accessible name', () => {
    render(<FilesHeaderControls {...props({ inboundMail: { href: '/app/projects/p/files/mail', waiting: 3 } })} />)
    const link = screen.getByTestId('files-inbound-mail')
    expect(link).toHaveAttribute('href', '/app/projects/p/files/mail')
    expect(link).toHaveAccessibleName('Project mail, 3 mails waiting to be filed')
    expect(link.querySelector('[data-slot="count-pill"], .tabular-nums')).not.toBeNull()
  })

  it('shows no pill while nothing waits, and no entry for a reader who may not decide', () => {
    const { unmount } = render(<FilesHeaderControls {...props({ inboundMail: { href: '/x', waiting: 0 } })} />)
    expect(screen.getByTestId('files-inbound-mail')).toHaveTextContent(/^Project mail$/)
    unmount()
    render(<FilesHeaderControls {...props()} />)
    expect(screen.queryByTestId('files-inbound-mail')).not.toBeInTheDocument()
  })

  it('is an entry of the phone’s ⋯ with the count as its hint', async () => {
    render(<FilesHeaderControls {...props({ phone: true, inboundMail: { href: '/x', waiting: 2 } })} />)
    await userEvent.click(screen.getByTestId('files-more'))
    expect(await screen.findByTestId('files-inbound-mail')).toHaveTextContent('2 mails wait to be filed')
  })
})
