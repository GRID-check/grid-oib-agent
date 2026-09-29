import { describe, expect, it, vi } from 'vitest'
import { ListingFetchError, MAX_LISTING_PAGES, fetchListingPages } from './fetch-listing-pages'

/** A fetch double answering a fixed sequence of page bodies (or statuses). */
function pages(...answers: Array<{ documents?: string[]; nextCursor?: string | null } | number>) {
  const urls: string[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const answer = answers.shift() ?? { documents: [], nextCursor: null }
    if (typeof answer === 'number') return new Response(null, { status: answer })
    return Response.json(answer)
  }) as unknown as typeof fetch
  return { fetcher, urls }
}

describe('fetchListingPages', () => {
  it('reads one page when there is no next cursor', async () => {
    const { fetcher, urls } = pages({ documents: ['a'], nextCursor: null })
    const result = await fetchListingPages<string>('/api/documents?projectId=p', { fetcher })
    expect(result).toMatchObject({ documents: ['a'], truncated: false })
    expect(urls).toEqual(['/api/documents?projectId=p'])
  })

  it('follows the cursor, appending it to an existing query or starting one', async () => {
    const withQuery = pages({ documents: ['a'], nextCursor: 'x/y' }, { documents: ['b'] })
    const result = await fetchListingPages<string>('/api/documents?projectId=p', { fetcher: withQuery.fetcher })
    expect(result.documents).toEqual(['a', 'b'])
    expect(withQuery.urls[1]).toBe('/api/documents?projectId=p&cursor=x%2Fy')

    const bare = pages({ documents: [], nextCursor: 'c' }, { documents: [] })
    await fetchListingPages<string>('/api/archiv/documents', { fetcher: bare.fetcher })
    expect(bare.urls[1]).toBe('/api/archiv/documents?cursor=c')
  })

  it('keeps the first body for the fields beside the rows', async () => {
    const { fetcher } = pages(
      { documents: [], nextCursor: 'c', collectionName: 'archiv_1' } as never,
      { documents: [], collectionName: 'ignored' } as never,
    )
    const result = await fetchListingPages<string, { documents?: string[]; collectionName?: string }>('/x', { fetcher })
    expect(result.first.collectionName).toBe('archiv_1')
  })

  it('stops at the page ceiling and reports it', async () => {
    const endless = Array.from({ length: MAX_LISTING_PAGES + 5 }, (_, i) => ({ documents: [String(i)], nextCursor: `c${i}` }))
    const { fetcher, urls } = pages(...endless)
    const result = await fetchListingPages<string>('/x', { fetcher })
    expect(result.truncated).toBe(true)
    expect(urls).toHaveLength(MAX_LISTING_PAGES)
    expect(result.documents).toHaveLength(MAX_LISTING_PAGES)
  })

  it('throws with the status of a failed page, so a caller can read 403 as absent', async () => {
    const { fetcher } = pages({ documents: ['a'], nextCursor: 'c' }, 403)
    await expect(fetchListingPages<string>('/x', { fetcher })).rejects.toMatchObject({
      status: 403,
    })
    await expect(fetchListingPages<string>('/x', { fetcher: pages(500).fetcher })).rejects.toBeInstanceOf(
      ListingFetchError,
    )
  })
})
