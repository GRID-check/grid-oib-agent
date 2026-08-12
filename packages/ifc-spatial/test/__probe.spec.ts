import { it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass } from '../src/geometry/pass.js'

it('probe', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
  const g = await buildGraph(bytes)
  const geo = await runGeometryPass(bytes, g)
  const f = (n: number) => n.toFixed(3)

  // For each wall: bin triangles by (quantized normal, quantized offset) and report area per plane.
  for (const id of ['3cUkl32yn9qRSPvBJVyWw5', '3cUkl32yn9qRSPvBJVyWx4', '3cUkl32yn9qRSPvBJVyWy4', '3cUkl32yn9qRSPvAVVyWcE']) {
    const e = geo.elements.get(id)!
    const t = e.triangles!
    const bins = new Map<string, number>()
    for (let i = 0; i < t.length; i += 9) {
      const ax = t[i]!, ay = t[i + 1]!, az = t[i + 2]!
      const bx = t[i + 3]!, by = t[i + 4]!, bz = t[i + 5]!
      const cx = t[i + 6]!, cy = t[i + 7]!, cz = t[i + 8]!
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      const d = Math.hypot(nx, ny, nz)
      if (d < 1e-12) continue
      nx /= d; ny /= d; nz /= d
      const off = nx * ax + ny * ay + nz * az
      const key = `${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)} @ ${off.toFixed(3)}`
      bins.set(key, (bins.get(key) ?? 0) + d / 2)
    }
    const sorted = [...bins].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log('=== ', id, g.nodes.get(id)?.ifcType, 'box', JSON.stringify(e.box))
    console.log('    pass.facade', e.facade ? `n=${e.facade.normal.map(f)} p=${e.facade.point.map(f)} a=${f(e.facade.area)}` : 'none')
    for (const [k, a] of sorted) console.log('    plane', k, 'area', f(a))
  }

  // roof point cloud near the north eave, all x
  const roof = geo.elements.get('3cUkl32yn9qRSPvBJVyWh4')!
  const t = roof.triangles!
  const pts = new Set<string>()
  for (let i = 0; i < t.length; i += 3) {
    if (t[i + 1]! < 4.5) continue
    pts.add(`${t[i]!.toFixed(2)} ${t[i + 1]!.toFixed(3)} ${t[i + 2]!.toFixed(3)}`)
  }
  console.log('ROOF vertices with y>4.5:', pts.size)
  for (const p of [...pts].sort()) console.log('   ', p)
}, 300000)
