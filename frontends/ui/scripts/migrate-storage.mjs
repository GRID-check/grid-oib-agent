#!/usr/bin/env node
/**
 * One-shot object copy from MinIO (source) to SeaweedFS (destination).
 *
 * Both speak S3 and this repo keeps the SAME bucket name and object-key layout
 * across the migration (see lib/s3.ts buildStorageKey), so this is a straight
 * 1:1 copy — every document/thumbnail lands under the identical key, and the
 * `documents.storage_key` pointers keep resolving with no re-ingestion.
 *
 * It is SAFE and IDEMPOTENT:
 *   - It only READS from the source and WRITES to the destination. It never
 *     deletes anything from either side, so a bad run cannot lose data.
 *   - Re-runs skip objects already present in the destination with a matching
 *     size, so you can run it repeatedly (e.g. a final sync at cutover).
 *
 * Usage (run from frontends/ui, where @aws-sdk/client-s3 is installed):
 *   # copy everything
 *   SRC_ENDPOINT=http://localhost:9000 SRC_ACCESS_KEY=minioadmin SRC_SECRET_KEY=minioadmin \
 *   DST_ENDPOINT=http://localhost:8333 DST_ACCESS_KEY=seaweedadmin DST_SECRET_KEY=seaweedadmin \
 *   node scripts/migrate-storage.mjs
 *
 *   # preview what would copy, change nothing
 *   node scripts/migrate-storage.mjs --dry-run
 *
 *   # after copying, confirm the destination matches the source
 *   node scripts/migrate-storage.mjs --verify-only
 *
 * Env (SRC_* fall back to the legacy MINIO_*, DST_* to the new SEAWEED_*, so a
 * mid-cutover box with both sets configured needs no extra wiring):
 *   SRC_ENDPOINT / SRC_ACCESS_KEY / SRC_SECRET_KEY / SRC_BUCKET   (MinIO)
 *   DST_ENDPOINT / DST_ACCESS_KEY / DST_SECRET_KEY / DST_BUCKET   (SeaweedFS)
 *   MIGRATE_CONCURRENCY   parallel objects in flight (default 8)
 *
 * Note: objects are buffered in memory one at a time per worker, which is fine
 * for documents/PDFs. For very large objects (multi-GB) prefer a streaming tool
 * such as `rclone sync src:bucket dst:bucket`.
 */

import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const VERIFY_ONLY = args.has('--verify-only')
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY || 8))

const src = {
  endpoint: process.env.SRC_ENDPOINT || process.env.MINIO_ENDPOINT,
  accessKeyId: process.env.SRC_ACCESS_KEY || process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.SRC_SECRET_KEY || process.env.MINIO_SECRET_KEY,
  bucket: process.env.SRC_BUCKET || process.env.MINIO_BUCKET || 'grid-documents',
}
const dst = {
  endpoint: process.env.DST_ENDPOINT || process.env.SEAWEED_ENDPOINT,
  accessKeyId: process.env.DST_ACCESS_KEY || process.env.SEAWEED_ACCESS_KEY,
  secretAccessKey: process.env.DST_SECRET_KEY || process.env.SEAWEED_SECRET_KEY,
  bucket: process.env.DST_BUCKET || process.env.SEAWEED_BUCKET || 'grid-documents',
}

const ENV_SUFFIX = { endpoint: 'ENDPOINT', accessKeyId: 'ACCESS_KEY', secretAccessKey: 'SECRET_KEY' }

function assertConfigured(side, cfg) {
  const prefix = side === 'source' ? 'SRC_' : 'DST_'
  const missing = Object.keys(ENV_SUFFIX)
    .filter((k) => !cfg[k])
    .map((k) => prefix + ENV_SUFFIX[k])
  if (missing.length) {
    console.error(`[migrate] ${side} storage is not configured — set ${missing.join(', ')}`)
    process.exit(2)
  }
}
assertConfigured('source', src)
assertConfigured('destination', dst)

const makeClient = (cfg) =>
  new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  })

const source = makeClient(src)
const dest = makeClient(dst)

/** Yield every object ({ Key, Size }) in a bucket, following pagination. */
async function* listAll(client, bucket) {
  let ContinuationToken
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken }),
    )
    for (const obj of page.Contents || []) yield { Key: obj.Key, Size: obj.Size }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (ContinuationToken)
}

/** Destination object size, or null when it does not exist. */
async function destSize(key) {
  try {
    const head = await dest.send(new HeadObjectCommand({ Bucket: dst.bucket, Key: key }))
    return head.ContentLength ?? null
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

/** Copy one object source→dest, preserving content type. Skips if already present with same size. */
async function copyOne({ Key, Size }) {
  const existing = await destSize(Key)
  if (existing !== null && existing === Size) return 'skipped'
  if (DRY_RUN) return 'would-copy'

  const obj = await source.send(new GetObjectCommand({ Bucket: src.bucket, Key }))
  const body = await obj.Body.transformToByteArray()
  await dest.send(
    new PutObjectCommand({
      Bucket: dst.bucket,
      Key,
      Body: body,
      ContentType: obj.ContentType || 'application/octet-stream',
    }),
  )
  return 'copied'
}

/** Run `task` over `items` with a bounded number of workers. */
async function pool(items, worker) {
  let index = 0
  const results = []
  const runNext = async () => {
    while (index < items.length) {
      const i = index++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runNext))
  return results
}

async function collectSource() {
  const objects = []
  let bytes = 0
  for await (const o of listAll(source, src.bucket)) {
    objects.push(o)
    bytes += o.Size || 0
  }
  return { objects, bytes }
}

async function verify() {
  console.log(`[migrate] verifying ${src.bucket}(source) against ${dst.bucket}(dest)…`)
  const { objects, bytes } = await collectSource()

  const destMap = new Map()
  for await (const o of listAll(dest, dst.bucket)) destMap.set(o.Key, o.Size)

  const missing = []
  const mismatched = []
  for (const o of objects) {
    if (!destMap.has(o.Key)) missing.push(o.Key)
    else if (destMap.get(o.Key) !== o.Size) mismatched.push(o.Key)
  }

  console.log(`[migrate] source: ${objects.length} objects, ${fmtBytes(bytes)}`)
  console.log(`[migrate] dest:   ${destMap.size} objects`)
  if (missing.length) console.error(`[migrate] MISSING in dest (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}${missing.length > 20 ? '\n  …' : ''}`)
  if (mismatched.length) console.error(`[migrate] SIZE MISMATCH (${mismatched.length}):\n  ${mismatched.slice(0, 20).join('\n  ')}${mismatched.length > 20 ? '\n  …' : ''}`)

  if (missing.length || mismatched.length) {
    console.error('[migrate] verification FAILED — re-run the copy (it is idempotent).')
    process.exitCode = 1
  } else {
    console.log('[migrate] verification OK — every source object is present in the destination with a matching size.')
  }
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

async function migrate() {
  console.log(`[migrate] ${DRY_RUN ? 'DRY RUN — ' : ''}copying ${src.bucket} @ ${src.endpoint}  →  ${dst.bucket} @ ${dst.endpoint}`)
  const { objects, bytes } = await collectSource()
  console.log(`[migrate] source has ${objects.length} objects (${fmtBytes(bytes)}); concurrency ${CONCURRENCY}`)

  const counts = { copied: 0, skipped: 0, 'would-copy': 0, failed: 0 }
  let done = 0
  const failures = []

  await pool(objects, async (o) => {
    try {
      const outcome = await copyOne(o)
      counts[outcome]++
    } catch (err) {
      counts.failed++
      failures.push({ key: o.Key, error: err?.message || String(err) })
    }
    if (++done % 200 === 0) console.log(`[migrate] …${done}/${objects.length}`)
  })

  console.log(
    `[migrate] done — copied ${counts.copied}, skipped ${counts.skipped}` +
      (DRY_RUN ? `, would-copy ${counts['would-copy']}` : '') +
      `, failed ${counts.failed}`,
  )
  if (failures.length) {
    console.error(`[migrate] failures (${failures.length}):`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.key}: ${f.error}`)
    if (failures.length > 20) console.error('  …')
    process.exitCode = 1
    return
  }
  if (!DRY_RUN) await verify()
}

const run = VERIFY_ONLY ? verify : migrate
run().catch((err) => {
  console.error('[migrate] fatal:', err?.message || err)
  process.exitCode = 1
})
