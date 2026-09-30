import { fireEvent, render, screen, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZdrGroupNotice, ZdrPolicySection, type ZdrCoverage } from './zdr-policy-section'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const CHECKED: ZdrCoverage = { status: 'checked', blockedGroups: [], unresolvedGroups: [] }

const section = (props: Partial<Parameters<typeof ZdrPolicySection>[0]> = {}) => {
  const onChanged = vi.fn(async () => undefined)
  render(
    <ZdrPolicySection
      zdrOnly
      zdrApplicable
      provider={null}
      coverage={CHECKED}
      onChanged={onChanged}
      {...props}
    />
  )
  return { onChanged }
}

describe('ZdrPolicySection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        Response.json({ zdrOnly: JSON.parse(String(init?.body)).enabled, zdrApplicable: true, zdrCoverage: null })
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('turning it off needs the "I understand" box before the destructive confirm enables', async () => {
    const { onChanged } = section()
    fireEvent.click(screen.getByRole('switch'))
    const confirm = await screen.findByTestId('zdr-disable-confirm')
    expect(confirm).toBeDisabled()
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ enabled: false })
  })

  it('turning it back on needs no confirmation', async () => {
    const { onChanged } = section({ zdrOnly: false, coverage: null })
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByTestId('zdr-disable-confirm')).not.toBeInTheDocument()
  })

  it('shows a persistent banner while ZDR is off', () => {
    section({ zdrOnly: false, coverage: null })
    expect(screen.getByTestId('zdr-off-banner')).toHaveTextContent(/may store/i)
  })

  it('names a 403 as a permission problem, not a generic failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 403 }))
    section({ zdrOnly: false, coverage: null })
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Manage AI models/)))
  })

  it('disables the switch when ZDR cannot apply to the org’s own provider, and says why', () => {
    section({ zdrApplicable: false, provider: 'openai', coverage: null })
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.getByRole('switch')).not.toBeChecked()
    // The provider's display name, never its raw id ("openai").
    expect(screen.getByText(/contract with OpenAI\b/)).toBeInTheDocument()
    expect(screen.queryByText(/\bopenai\b/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('zdr-off-banner')).not.toBeInTheDocument()
  })

  it('says the coverage is unknown when the ZDR list could not be read', () => {
    section({ coverage: { status: 'unknown', blockedGroups: [], unresolvedGroups: [] } })
    expect(screen.getByTestId('zdr-coverage-unknown')).toBeInTheDocument()
  })

  it('summarises blocked tasks', () => {
    section({
      coverage: {
        status: 'checked',
        blockedGroups: [{ group: 'deep_research', modelId: 'vendor/x', source: 'platform', reason: 'not_zdr' }],
        unresolvedGroups: [],
      },
    })
    expect(screen.getByTestId('zdr-blocked-summary')).toHaveTextContent('1 task cannot')
  })
})

describe('ZdrGroupNotice', () => {
  it('names the model, where it comes from, and that requests are refused', () => {
    render(
      <ZdrGroupNotice
        groupId="deep_research"
        coverage={{
          status: 'checked',
          blockedGroups: [{ group: 'deep_research', modelId: 'vendor/x', source: 'platform', reason: 'not_zdr' }],
          unresolvedGroups: [],
        }}
      />
    )
    expect(screen.getByTestId('zdr-notice-deep_research')).toHaveTextContent(
      'vendor/x (platform default) has no zero-data-retention endpoint'
    )
  })

  it('renders nothing for an unaffected task', () => {
    const { container } = render(<ZdrGroupNotice groupId="clarifier" coverage={CHECKED} />)
    expect(container).toBeEmptyDOMElement()
  })
})
