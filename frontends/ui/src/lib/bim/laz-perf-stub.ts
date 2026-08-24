/**
 * Stand-in for `laz-perf`, the LAZ point-cloud decoder.
 *
 * `@ifc-lite/renderer` re-exports a point-cloud renderer, which pulls in
 * `@ifc-lite/pointcloud` → `laz-perf`. That package ships an Emscripten loader
 * that imports the WASI interface module `wasi_snapshot_preview1` and two
 * virtual specifiers (`WASM_HELPER`, `WASM_PATH`) which no bundler can resolve,
 * so it fails the production build outright.
 *
 * Grid never decodes a point cloud. Point clouds reach ifc-lite through IFC5
 * (`.ifcx`) assets and explicit PCD input; a STEP IFC building model — the only
 * thing this product ingests — contains none. So the dependency is aliased to
 * this module in `next.config.ts` rather than worked around in the bundler.
 *
 * It is a loud stub, not an empty object: if a future feature does start
 * decoding point clouds, the failure is this message rather than an undefined
 * property somewhere inside a WASM shim.
 */

const MESSAGE =
  'laz-perf is stubbed out in this build (see src/lib/bim/laz-perf-stub.ts). ' +
  'Grid does not decode LAZ point clouds; remove the alias in next.config.ts to enable them.'

function unavailable(): never {
  throw new Error(MESSAGE)
}

export const createLazPerf = unavailable
export const LASZip = unavailable
export const ChunkDecoder = unavailable
export const DynamicLASZip = unavailable

export default unavailable
