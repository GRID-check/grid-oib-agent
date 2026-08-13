/**
 * Content-addressed graph cache.
 *
 * ## Why this exists at all
 *
 * The whole premise of this library is "just send the file": a host hands over
 * bytes and gets a {@link BuildingGraph} back, with no model id, no upload
 * table, no lifecycle to keep in step. That premise only survives contact with
 * a conversation if the same bytes are never parsed twice. A 150 MB IFC costs
 * seconds and several times its own size in peak memory to read; an agent that
 * asks four questions about one building must not pay that four times.
 *
 * The cache key is therefore the sha256 of the source bytes — the same hash the
 * builder already writes to {@link BuildingGraph.contentHash} — and not a file
 * name, a path or an upload id. Two consequences that are the point rather than
 * side effects: a re-upload of an unchanged file is a hit, and an edited file is
 * a guaranteed miss. Nothing here can serve a graph that belongs to different
 * bytes, which is the failure a name-keyed cache eventually produces and cannot
 * be talked out of.
 *
 * Hashing is not free — a few hundred milliseconds for a large file — but it is
 * an order of magnitude below the parse it decides, and it is the only way to
 * be certain the graph in hand describes the file in hand.
 *
 * ## What this cache is not
 *
 * Process-local and unsynchronised. It holds no lock, spans no replica and
 * survives no restart. A host that wants a shared or persistent cache should
 * put one in front of {@link GraphCache.load} rather than inside it: this class
 * exists to stop one process from re-parsing what it already holds, and the
 * moment it tries to be a distributed cache it acquires a coherence problem it
 * has no way to solve.
 *
 * It also has no tenancy. A hash is not a permission — a host that serves
 * several tenants from one process must decide whether a caller may see a
 * building BEFORE it reaches this cache, because a cache keyed on content
 * happily serves anyone who can produce the same bytes.
 */

import { createHash } from 'node:crypto'
import { buildGraph, type BuildOptions } from './graph/build.js'
import type { BuildingGraph } from './graph/types.js'

export interface GraphCacheOptions {
  /**
   * Hard lid on retained graphs. Small on purpose: a conversation touches one
   * building, occasionally two being compared, and the value of a third resident
   * graph is far below the cost of holding it.
   */
  maxEntries?: number
  /**
   * Lid on the ESTIMATED retained size (see {@link estimateBytes}). Present
   * because entry count alone cannot tell a sample house from a federated
   * hospital, and eight of the latter is not a cache, it is a leak.
   */
  maxBytes?: number
}

interface CacheEntry {
  graph: BuildingGraph
  /** Estimated, never measured. See {@link estimateBytes}. */
  bytes: number
}

/**
 * Rough per-object costs for the size estimate.
 *
 * These are shape arithmetic, not measurements: a `GraphNode` is eleven fields
 * of which most are heap strings the parser handed us (a GlobalId alone is 22
 * characters plus a string header), and an edge is charged more than its own
 * object because every edge also occupies two adjacency slots and contributes
 * Map keys. The numbers are deliberately round and deliberately generous — an
 * estimate that runs low is one that lets the cache overshoot the memory the
 * host actually has.
 */
const BYTES_PER_NODE = 320
const BYTES_PER_EDGE = 200
const BYTES_PER_DIALECT_ENTRY = 400
const BYTES_BASE = 64 * 1024

/**
 * Approximate retained size of a graph, in bytes.
 *
 * **This is an estimate and must never be reported as a measurement.** It is
 * derived from {@link BuildingGraph.stats} counts, so it knows nothing about
 * string interning, V8's actual object layout, or the fact that node names in a
 * German model are longer than in an English one. Its only job is to order
 * evictions and to stop the cache growing without bound; anything else — a
 * memory figure in a UI, a capacity plan, a billing number — is a misuse, and
 * the moment someone treats it as truth the estimate becomes a lie with a
 * decimal point on it.
 */
export function estimateBytes(graph: BuildingGraph): number {
  return (
    BYTES_BASE +
    graph.stats.nodes * BYTES_PER_NODE +
    graph.stats.edges * BYTES_PER_EDGE +
    graph.dialect.length * BYTES_PER_DIALECT_ENTRY
  )
}

/** sha256 of the bytes, hex — identical to what {@link buildGraph} stamps on the graph. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class GraphCache {
  /**
   * Insertion order IS the LRU order: a hit deletes and re-inserts, so the
   * oldest key is always the first one `Map` iteration yields. No second
   * structure, no timestamps to keep in step with the entries they describe.
   */
  readonly #entries = new Map<string, CacheEntry>()

  /**
   * Parses currently running, keyed by hash — the single-flight table.
   *
   * Two concurrent `load()` calls for the same bytes must produce ONE parse.
   * Without this map they produce two, and the two peak at the same instant:
   * a 150 MB model parsed twice concurrently costs twice the peak memory at
   * exactly the moment memory is tightest, which is how a process that handles
   * one big model comfortably dies on two identical requests that arrive a
   * hundred milliseconds apart. That is not a rare race — it is the ordinary
   * shape of a user double-clicking, a retry landing on the same replica, or an
   * agent firing two tool calls at one building.
   *
   * Note this deduplicates by CONTENT, so it also collapses the case the caller
   * cannot see: two different requests that happen to carry the same file.
   */
  readonly #inFlight = new Map<string, Promise<BuildingGraph>>()

  readonly #maxEntries: number
  readonly #maxBytes: number

  #hits = 0
  #misses = 0
  #bytes = 0

  constructor(options: GraphCacheOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? 8)
    this.#maxBytes = Math.max(1, options.maxBytes ?? 512 * 1024 * 1024)
  }

  /**
   * Counters for the process, not for a request.
   *
   * `misses` counts PARSES STARTED, and `hits` counts calls served without one —
   * including a call that joined a parse already in flight. Defined that way
   * because the number anyone actually wants from a cache is "how many times did
   * we read an IFC", and a coalesced caller did not.
   *
   * `bytes` is the estimate described in {@link estimateBytes}. It is a
   * snapshot: reading it twice around a `load()` is the only honest way to see
   * what that load cost, and even then only approximately.
   */
  get stats(): { hits: number; misses: number; entries: number; bytes: number } {
    return { hits: this.#hits, misses: this.#misses, entries: this.#entries.size, bytes: this.#bytes }
  }

  /**
   * The graph for `hash`, or `null`.
   *
   * This is the lookup a caller makes when it already has a hash and does NOT
   * have the bytes — "do I need to ask the user to re-upload". It records a hit
   * or a miss, because it is a real cache lookup; `load()` deliberately does not
   * go through it, so a load can never be counted twice.
   */
  get(hash: string): BuildingGraph | null {
    const entry = this.#touch(hash)
    if (entry) {
      this.#hits++
      return entry.graph
    }
    this.#misses++
    return null
  }

  /**
   * Is `hash` resident?
   *
   * Neither counted nor treated as a use: a question ABOUT the cache must not
   * change what the cache would evict next, or a monitoring loop quietly becomes
   * the thing that decides retention.
   */
  has(hash: string): boolean {
    return this.#entries.has(hash)
  }

  /**
   * The graph for these bytes — from the cache, from a parse already running, or
   * from a parse this call starts. Exactly one of the three.
   *
   * `options` are honoured only by the call that actually parses. A hit returns
   * the graph as it was built, which means a caller that passes a different
   * `dialectSampleSize` for the same bytes gets the earlier sampling. That is
   * the correct trade — re-parsing 150 MB to re-measure a dialect sample is not
   * a bargain anyone would take knowingly — but it is worth knowing, and a host
   * that needs different build options for the same file should use a second
   * cache instance rather than hoping.
   */
  async load(bytes: Uint8Array, options: BuildOptions = {}): Promise<BuildingGraph> {
    const hash = hashBytes(bytes)

    const resident = this.#touch(hash)
    if (resident) {
      this.#hits++
      return resident.graph
    }

    const running = this.#inFlight.get(hash)
    if (running) {
      this.#hits++
      return running
    }

    this.#misses++

    // The stored promise is the one every caller receives, so a rejection is
    // observed by all of them and by nothing else. Admission happens on the
    // success path only: a parse that threw must never leave a half-built or
    // absent graph behind a cache hit, because the next caller would then be
    // served a failure it cannot see and cannot retry out of.
    const parse = buildGraph(bytes, options).then((graph) => {
      this.#admit(hash, graph)
      return graph
    })
    // The in-flight entry is cleared on BOTH outcomes. Leaving a rejected
    // promise in the map would poison the hash for the life of the process:
    // every later caller would join a parse that already failed and receive its
    // error, turning one transient failure — a truncated upload, a momentary
    // allocation failure — into a permanent one for those exact bytes.
    const tracked = parse.finally(() => {
      this.#inFlight.delete(hash)
    })

    this.#inFlight.set(hash, tracked)
    return tracked
  }

  /**
   * Drop every retained graph.
   *
   * Parses already in flight are left running and their results are still
   * admitted. They are not ours to cancel — callers are waiting on them — and a
   * graph is valid for its hash no matter when it was asked for, so refusing to
   * admit it would only guarantee the next caller re-parses the same file. What
   * `clear()` releases is what the cache is holding, which is the only memory it
   * controls.
   *
   * `hits` and `misses` survive: they describe the process's history, and
   * resetting them on a clear would hide the very re-parses a clear causes.
   */
  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  /** Look up and promote to most-recently-used in one step. */
  #touch(hash: string): CacheEntry | null {
    const entry = this.#entries.get(hash)
    if (!entry) return null
    this.#entries.delete(hash)
    this.#entries.set(hash, entry)
    return entry
  }

  #admit(hash: string, graph: BuildingGraph): void {
    const bytes = estimateBytes(graph)
    const existing = this.#entries.get(hash)
    if (existing) this.#bytes -= existing.bytes
    this.#entries.delete(hash)
    this.#entries.set(hash, { graph, bytes })
    this.#bytes += bytes
    this.#evict(hash)
  }

  /**
   * Evict oldest-first until both lids hold — but never the entry just admitted.
   *
   * A cache that can evict what it has only just stored re-parses the same file
   * on every single call, which is worse than no cache: same parse cost, plus
   * the hashing, plus a stats line claiming a cache exists. So a single graph
   * larger than `maxBytes` is kept, alone, and the limit is treated as a
   * high-water mark rather than a promise.
   */
  #evict(keep: string): void {
    for (const [hash, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) return
      if (hash === keep) continue
      this.#entries.delete(hash)
      this.#bytes -= entry.bytes
    }
  }
}
