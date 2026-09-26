/**
 * A filed mindmap is the tree the answer shows, not mermaid's mindmap: no
 * quotes around bare branches, the whole root label, the branches in the
 * order the answer wrote them, and bytes the server's SVG allow-list keeps.
 */
import { describe, expect, it } from 'vitest'
import { parseDiagramSvg, serializeDiagramSvg } from '@/lib/diagrams/svg'
import { parseMermaid } from './parse-mermaid'
import { mapSvg } from './map-svg'
import type { MapModel, MapNode } from './model'

const INK = { ink: '#1f2023', line: '#6b6e76', fill: '#f2f2f3' }

const node = (label: string, ...children: MapNode[]): MapNode => ({ id: label, label, children })

const texts = (svg: string): string[] =>
  [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]!)

describe('mapSvg', () => {
  it('draws the model the view draws, from a source written the way the model writes it', async () => {
    const model = await parseMermaid(
      'mindmap\n  root(("OIB-Richtlinie 2"))\n    "Grundrichtlinie"\n      "Fluchtwege"\n    "OIB-RL 2.2"'
    )
    expect(model?.kind).toBe('map')
    const svg = mapSvg(model as MapModel, INK)
    expect(texts(svg)).toEqual(['OIB-Richtlinie 2', 'Grundrichtlinie', 'Fluchtwege', 'OIB-RL 2.2'])
    expect(svg).not.toContain('&quot;')
  })

  it('passes the server’s SVG allow-list unchanged in substance', () => {
    const svg = mapSvg({ kind: 'map', root: node('Root', node('A', node('a1')), node('B')) }, INK)
    const kept = serializeDiagramSvg(parseDiagramSvg(svg).root)
    expect(texts(kept)).toEqual(['Root', 'A', 'a1', 'B'])
    expect(kept).toContain('<path')
    expect(kept).toContain('<rect')
  })

  it('stacks the branches top to bottom in the order written', () => {
    const svg = mapSvg(
      { kind: 'map', root: node('Root', node('Erster'), node('Zweiter'), node('Dritter')) },
      INK
    )
    const y = (label: string) => Number(new RegExp(`y="([\\d.]+)">${label}<`).exec(svg)?.[1])
    expect(y('Erster')).toBeLessThan(y('Zweiter'))
    expect(y('Zweiter')).toBeLessThan(y('Dritter'))
  })

  it('wraps a long label instead of drawing it off the page', () => {
    const long =
      'Brandschutz für Gebäude der Gebäudeklassen 1 bis 5 mit einem Fluchtniveau bis 22 m'
    const svg = mapSvg({ kind: 'map', root: node('Root', node('Teil', node(long))) }, INK)
    const lines = texts(svg).slice(2)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe(long)
  })

  it('escapes what XML would read as markup', () => {
    const svg = mapSvg({ kind: 'map', root: node('A < B & C') }, INK)
    expect(() => parseDiagramSvg(svg)).not.toThrow()
    expect(svg).toContain('A &lt; B &amp; C')
  })

  it('keeps a line break the label already has, even when the label would fit', () => {
    const svg = mapSvg({ kind: 'map', root: node('Root', node('OIB-RL 2\nBrandschutz')) }, INK)
    expect(texts(svg)).toEqual(['Root', 'OIB-RL 2', 'Brandschutz'])
  })
})
