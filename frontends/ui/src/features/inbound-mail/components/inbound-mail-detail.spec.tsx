/**
 * One held mail, decided: the bar says what will happen and sends exactly
 * that; a sender who needs confirming is confirmed first; a colleague who
 * decided first wins and the detail says so; the text is never markup; the
 * content check's choice reaches the request; dismissing offers the undo; a
 * filed text offers the follow, only where it could ever hold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files/mail',
  useSearchParams: () => new URLSearchParams(),
}))

import { toast } from 'sonner'
import { render, screen, waitFor, within } from '@/test-utils'
import { ApiRequestError } from '@/adapters/api/api-error'
import { DETAIL_VARIANTS, FIXTURE_NOW, FOLDERS, PROJECT_ID, fixtureClient, mail, messagePart, text } from '@/app/dev/inbound-mail/fixtures'
import type { InboundMailClient } from '../lib/client'
import { InboundMailDetail } from './inbound-mail-detail'

function renderDetail(name: string, client: InboundMailClient = fixtureClient({ detail: DETAIL_VARIANTS[name] }), onChanged = vi.fn()) {
  const fixture = DETAIL_VARIANTS[name]
  render(
    <InboundMailDetail
      projectId={PROJECT_ID}
      mailId={fixture.view.id}
      initial={fixture.view}
      initialText={fixture.text}
      folders={FOLDERS}
      client={client}
      onChanged={onChanged}
      now={FIXTURE_NOW}
      pollMs={1}
      decidedByOther={fixture.decidedByOther}
    />
  )
  return { client, onChanged }
}

beforeEach(() => vi.clearAllMocks())

describe('InboundMailDetail', () => {
  it('says what the press will file, and files exactly that', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    const file = vi.spyOn(client, 'file')
    const { onChanged } = renderDetail('member-verified', client)
    const button = screen.getByTestId('decision-file')
    expect(button).toHaveTextContent('File 1 file and the mail text')
    await userEvent.click(button)
    await waitFor(() => expect(file).toHaveBeenCalledTimes(1))
    const body = file.mock.calls[0][1]
    expect(body.mails).toHaveLength(1)
    expect(body.mails[0]).toMatchObject({
      mailId: DETAIL_VARIANTS['member-verified'].view.id,
      message: { text: 'full', thread: { action: 'append' } },
      parts: [{ folderId: FOLDERS[1].id, newFolderPath: null, documentType: 'Bescheid' }],
    })
    expect(body.mails[0]).not.toHaveProperty('acknowledgeSender')
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith('1 file filed', expect.anything())
  })

  it('names the thread and its revision when only the text goes', () => {
    renderDetail('thread-append')
    expect(screen.getByTestId('decision-file')).toHaveTextContent('File in mail thread “Stellplatznachweis” (becomes revision 4)')
  })

  it('asks for the unverified domain before filing, and sends the yes', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS.impersonation })
    const file = vi.spyOn(client, 'file')
    renderDetail('impersonation', client)
    expect(screen.getByTestId('sender-trust')).toHaveTextContent('Poses as Miriam Huber')
    const button = screen.getByTestId('decision-file')
    expect(button).toBeDisabled()
    await userEvent.click(screen.getByTestId('acknowledge-sender'))
    expect(button).toBeEnabled()
    await userEvent.click(button)
    await waitFor(() => expect(file).toHaveBeenCalled())
    expect(file.mock.calls[0][1].mails[0].acknowledgeSender).toBe(true)
  })

  it('reads the mail again when a colleague decided first, and says so', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    vi.spyOn(client, 'file').mockRejectedValue(new ApiRequestError('stale', 409, 'stale'))
    const handled = mail({ key: 'member-verified', status: 'handled', parts: [messagePart({ id: 'x', state: 'filed' })] })
    vi.spyOn(client, 'get').mockResolvedValue({ ...handled, id: DETAIL_VARIANTS['member-verified'].view.id })
    renderDetail('member-verified', client)
    await userEvent.click(screen.getByTestId('decision-file'))
    expect(await screen.findByTestId('detail-decided-by-other')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('changed in the meantime'))
    expect(screen.queryByTestId('decision-bar')).not.toBeInTheDocument()
  })

  it('prints a stranger’s markup as text, and a link as inert text', () => {
    const fixture = DETAIL_VARIANTS['member-verified']
    render(
      <InboundMailDetail
        projectId={PROJECT_ID}
        mailId={fixture.view.id}
        initial={fixture.view}
        initialText={text({ ownText: '<img src=x onerror="alert(1)"> https://evil.example/x', quoted: [] })}
        folders={FOLDERS}
        client={fixtureClient({ detail: fixture })}
        onChanged={vi.fn()}
      />
    )
    const own = screen.getByTestId('mail-text-own')
    expect(own.querySelector('img')).toBeNull()
    expect(own.querySelector('a')).toBeNull()
    expect(own).toHaveTextContent('<img src=x onerror="alert(1)">')
  })

  it('files a text with findings masked by default, whole when chosen', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['content-finding'] })
    const file = vi.spyOn(client, 'file')
    renderDetail('content-finding', client)
    expect(screen.getByTestId('content-finding-choice')).toHaveTextContent('IBAN')
    await userEvent.click(screen.getByTestId('finding-full'))
    await userEvent.click(screen.getByTestId('decision-file'))
    await waitFor(() => expect(file).toHaveBeenCalled())
    expect(file.mock.calls[0][1].mails[0].message?.text).toBe('full')
  })

  it('dismisses with an undo that restores', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    const restore = vi.spyOn(client, 'restore')
    renderDetail('member-verified', client)
    await userEvent.click(screen.getByTestId('decision-dismiss'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mail dismissed', expect.objectContaining({ action: expect.any(Object) })))
    const action = vi.mocked(toast.success).mock.calls.at(-1)?.[1]?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) throw new Error('the dismissal offered no undo')
    action.onClick({} as never)
    await waitFor(() => expect(restore).toHaveBeenCalled())
    expect(await screen.findByTestId('decision-bar')).toBeInTheDocument()
  })

  it('offers the follow after the text was filed, for a sender who could qualify', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['follow-offer'] })
    const follow = vi.spyOn(client, 'follow')
    renderDetail('follow-offer', client)
    await userEvent.click(await screen.findByTestId('follow-offer-button'))
    await waitFor(() => expect(follow).toHaveBeenCalledWith(PROJECT_ID, expect.any(String)))
    expect(await screen.findByText('You follow “Stellplatznachweis”')).toBeInTheDocument()
  })

  it('offers no follow where a reply could never qualify', async () => {
    const fixture = DETAIL_VARIANTS['follow-offer']
    const view = { ...fixture.view, sender: { ...fixture.view.sender!, trust: 'external_unverified' as const, reason: 'dkim_none' as const } }
    const client = fixtureClient({ detail: { ...fixture, view } })
    const lookup = vi.spyOn(client, 'threadOfDocument')
    render(<InboundMailDetail projectId={PROJECT_ID} mailId={view.id} initial={view} initialText={fixture.text} folders={FOLDERS} client={client} onChanged={vi.fn()} />)
    await screen.findByTestId('message-filed')
    expect(lookup).not.toHaveBeenCalled()
    expect(screen.queryByTestId('follow-offer')).not.toBeInTheDocument()
  })

  it('states every attachment case of the mixed mail', () => {
    renderDetail('mixed-attachments')
    expect(screen.getByTestId('note-revision')).toHaveTextContent('becomes revision 3 of S-101_B.pdf')
    expect(screen.getByTestId('note-duplicate')).toHaveTextContent('Already in the project: Behörde/Bescheide/Bescheid_alt.pdf')
    expect(screen.getByTestId('note-encrypted')).toBeInTheDocument()
    expect(screen.getByTestId('note-image')).toBeInTheDocument()
    expect(screen.getByTestId('not-staged')).toHaveTextContent('winmail.dat · Outlook’s own attachment')
    expect(screen.getByTestId('not-staged')).toHaveTextContent('2 pictures from the signature')
  })

  it('offers no checkbox it could not honour', () => {
    renderDetail('scan-pending')
    for (const row of screen.getAllByTestId(/^attachment-/).filter((element) => element.tagName === 'LI')) {
      expect(within(row).getByTestId('attachment-checkbox')).toBeDisabled()
    }
    expect(screen.getByTestId('status-scan-pending')).toBeInTheDocument()
    expect(screen.getByTestId('status-scan-failed')).toBeInTheDocument()
  })

  it('needs „File anyway“ before a stopped name is filed', async () => {
    renderDetail('name-stop')
    await userEvent.click(screen.getByTestId('attachment-checkbox'))
    expect(screen.getByTestId('decision-file')).toBeDisabled()
    expect(screen.getByTestId('decision-blocker')).toHaveTextContent('Confirm the name check for 1 attachment.')
    await userEvent.click(screen.getByTestId('attachment-release-name'))
    expect(screen.getByTestId('decision-file')).toBeEnabled()
  })

  it('says a partial failure and a full storage from the mail itself', () => {
    renderDetail('partial-failure')
    expect(screen.getByTestId('detail-partial-failure')).toHaveTextContent('1 of 2 files could not be filed.')
    expect(screen.getByTestId('note-last-failure')).toHaveTextContent('the name is already taken')
  })

  it('says the project is closed and files nothing there', () => {
    renderDetail('closed')
    expect(screen.getByTestId('detail-closed')).toBeInTheDocument()
    expect(screen.getByTestId('decision-file')).toHaveTextContent('File nothing')
  })

  it('offers the restore of an expired mail', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS.expired })
    const restore = vi.spyOn(client, 'restore')
    renderDetail('expired', client)
    await userEvent.click(screen.getByTestId('detail-restore'))
    await waitFor(() => expect(restore).toHaveBeenCalled())
  })

  it('shows its skeleton, then its error with a retry', async () => {
    renderDetail('error', fixtureClient({ detail: DETAIL_VARIANTS.error }))
    expect(screen.getByTestId('inbound-mail-detail')).toBeInTheDocument()
    const fixture = DETAIL_VARIANTS.error
    const client = fixtureClient({ detail: fixture })
    render(<InboundMailDetail projectId={PROJECT_ID} mailId={fixture.view.id} initial={null} folders={FOLDERS} client={client} onChanged={vi.fn()} />)
    expect(await screen.findByText('This mail could not be loaded.')).toBeInTheDocument()
  })
})
