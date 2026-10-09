import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { UploadScreeningCard } from './upload-screening-card'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/adapters/api/upload-screening-policy', () => ({ clearUploadScreeningPolicyCache: vi.fn() }))
import { toast } from 'sonner'
import { clearUploadScreeningPolicyCache } from '@/adapters/api/upload-screening-policy'

const OWN: UploadScreeningPolicy = {
  enabled: true,
  nameTerms: ['Rechnung'],
  nameExceptions: ['Berechnung'],
  contentTerms: ['Lohnzettel'],
  detectors: ['iban'],
}

function stubApi(state: { policy: UploadScreeningPolicy; suggested: boolean }, putStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        if (putStatus !== 200) return Response.json({ error: { message: 'no' } }, { status: putStatus })
        return Response.json({ policy: JSON.parse(String(init.body)), suggested: false })
      }
      return Response.json({ ...state, suggestion: SUGGESTED_SCREENING_POLICY })
    })
  )
}

const putBody = (): unknown => {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')
  return JSON.parse(String(call?.[1]?.body))
}

const termField = (label: string) => screen.getByRole('textbox', { name: label })

describe('UploadScreeningCard', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('says the suggestion is in force until the office saves its own', async () => {
    stubApi({ policy: SUGGESTED_SCREENING_POLICY, suggested: true })
    render(<UploadScreeningCard canEdit />)
    expect(await screen.findByTestId('upload-screening-suggested')).toHaveTextContent(/suggestion applies/i)
    // Saving the suggestion unchanged is allowed: it makes it the office's own.
    expect(screen.getByTestId('upload-screening-save')).toBeEnabled()
  })

  it('saves the normalized policy: trimmed, de-duplicated terms and detectors in canonical order', async () => {
    stubApi({ policy: OWN, suggested: false })
    render(<UploadScreeningCard canEdit />)
    const names = await screen.findByRole('textbox', { name: 'Name terms' })
    expect(screen.getByTestId('upload-screening-save')).toBeDisabled()

    fireEvent.change(names, { target: { value: '  Honorar  ' } })
    fireEvent.keyDown(names, { key: 'Enter' })
    fireEvent.change(names, { target: { value: 'rechnung' } })
    fireEvent.keyDown(names, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Credit card number' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Social security number (AT)' }))
    fireEvent.click(screen.getByTestId('upload-screening-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(putBody()).toEqual({
      enabled: true,
      nameTerms: ['Rechnung', 'Honorar'],
      nameExceptions: ['Berechnung'],
      contentTerms: ['Lohnzettel'],
      detectors: ['iban', 'at_svnr', 'credit_card'],
    })
    expect(clearUploadScreeningPolicyCache).toHaveBeenCalled()
    expect(screen.getByTestId('upload-screening-save')).toBeDisabled()
  })

  it('removes a term with its chip button', async () => {
    stubApi({ policy: OWN, suggested: false })
    render(<UploadScreeningCard canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Lohnzettel”' }))
    fireEvent.click(screen.getByTestId('upload-screening-save'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(putBody()).toMatchObject({ contentTerms: [] })
  })

  it('"Use suggestion" fills the form with Piloti’s list', async () => {
    stubApi({ policy: OWN, suggested: false })
    render(<UploadScreeningCard canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /use suggestion/i }))
    fireEvent.click(screen.getByTestId('upload-screening-save'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(putBody()).toEqual(SUGGESTED_SCREENING_POLICY)
  })

  it('names a 403 as a permission problem', async () => {
    stubApi({ policy: OWN, suggested: false }, 403)
    render(<UploadScreeningCard canEdit />)
    fireEvent.click(await screen.findByRole('switch'))
    fireEvent.click(screen.getByTestId('upload-screening-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Manage organization settings/))
    )
    expect(clearUploadScreeningPolicyCache).not.toHaveBeenCalled()
  })

  it('is read-only without org:settings:manage: chips, no typing, no buttons, disabled controls', async () => {
    stubApi({ policy: OWN, suggested: false })
    render(<UploadScreeningCard canEdit={false} />)
    const form = await screen.findByTestId('upload-screening-form')
    expect(screen.getByTestId('upload-screening-readonly')).toBeInTheDocument()
    expect(within(form).getByText('Rechnung')).toBeInTheDocument()
    expect(within(form).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(form).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled()
  })

  it('offers a retry when the policy cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    render(<UploadScreeningCard canEdit />)
    expect(await screen.findByText('Could not load the lists.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('labels each list for assistive tech', async () => {
    stubApi({ policy: OWN, suggested: false })
    render(<UploadScreeningCard canEdit />)
    expect(await screen.findByRole('textbox', { name: 'Name terms' })).toBeInTheDocument()
    expect(termField('Exceptions')).toBeInTheDocument()
    expect(termField('Content terms')).toBeInTheDocument()
  })
})
