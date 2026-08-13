import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass } from '../src/geometry/pass.js'
it('geometry on the real sample house', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
  const g = await buildGraph(bytes)
  const geo = await runGeometryPass(bytes, g)
  console.log('STATS', JSON.stringify(geo.stats))
  console.log('BOUNDS', JSON.stringify(geo.bounds))
  const f = (n: number) => n.toFixed(2)
  for (const t of ['IfcSpace', 'IfcRoof', 'IfcSlab', 'IfcWall', 'IfcWindow']) {
    for (const id of (g.byType.get(t) ?? []).slice(0, 4)) {
      const e = geo.elements.get(id)
      const n = g.nodes.get(id)
      if (!e) { console.log(t, n?.name, 'NO GEOMETRY'); continue }
      console.log(t, (n?.longName ?? n?.name ?? '').slice(0, 40),
        '| z', f(e.box.min[2]), '-', f(e.box.max[2]),
        '| floorArea', f(e.floorArea), '| surf', f(e.surfaceArea),
        '| facadeN', e.facade ? e.facade.normal.map(f).join(',') : 'none', '| tris', e.triangleCount)
    }
  }
  expect(geo.stats.elementsWithGeometry).toBeGreaterThan(20)
}, 180000)
