'use client'

/**
 * Dev preview for the platform admin primitives, shown as one worked example:
 * SectionCard chrome wrapping a DataToolbar + Table + Pagination, with a Sheet
 * for row detail.
 *
 * This is the pattern every platform section is being converted to, so it is
 * also the reference: if a surface needs something this page does not show, the
 * primitive is missing and should be added rather than hand-rolled. Not linked
 * from anywhere; 404s outside development.
 */

import { useMemo, useState } from 'react'
import { notFound } from 'next/navigation'
import { BookOpenCheck, MoreHorizontal, Trash2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataToolbar } from '@/components/ui/data-toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'

// Names must be unique — they are the React key AND the selection identity.
const ROWS = Array.from({ length: 14 }, (_, index) => ({
  name: `OIB-RL${index + 1}-2023.pdf`,
  title: `OIB-Richtlinie ${index + 1} — Ausgabe 2023`,
  cls: index % 3 === 0 ? 'Richtlinie' : index % 3 === 1 ? 'Leitfaden' : 'Merkblatt',
  state: index % 5 === 0 ? 'pending' : 'indexed',
  chunks: 40 + index * 7,
}))

const PAGE_SIZE = 8

export default function PlatformPrimitivesDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return <Preview />
}

function Preview(): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<(typeof ROWS)[number] | null>(null)

  const filtered = useMemo(
    () => ROWS.filter((row) => row.title.toLowerCase().includes(query.trim().toLowerCase())),
    [query],
  )
  const page = filtered.slice(offset, offset + PAGE_SIZE)
  const allOnPageSelected = page.length > 0 && page.every((row) => selected.includes(row.name))

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-lg font-semibold">Platform — admin primitives</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          SectionCard + DataToolbar + Table + Pagination + Sheet. The shape every platform section is converted to.
        </p>
      </div>

      <SectionCard
        title="Base knowledge"
        description="The shared corpus every project grounds its answers on."
        testId="primitives-demo"
        action={
          <Button size="sm">
            <Upload className="size-3.5" aria-hidden />
            Add documents
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <DataToolbar
            searchValue={query}
            onSearchChange={(value) => {
              setQuery(value)
              setOffset(0)
            }}
            searchPlaceholder="Filter documents…"
            searchLabel="Filter documents"
            clearLabel="Clear filter"
            selectedCount={selected.length}
            selectionLabel={(count) => `${count} selected`}
            onClearSelection={() => setSelected([])}
            clearSelectionLabel="Clear"
            selectionActions={
              <>
                <Button variant="outline" size="sm">
                  Reclassify
                </Button>
                <Button variant="outline" size="sm" className="text-destructive">
                  <Trash2 className="size-3.5" aria-hidden />
                  Delete
                </Button>
              </>
            }
            filters={
              <Select defaultValue="all">
                <SelectTrigger size="sm" className="w-40" aria-label="Document type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="richtlinie">Richtlinie</SelectItem>
                  <SelectItem value="leitfaden">Leitfaden</SelectItem>
                </SelectContent>
              </Select>
            }
          />

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Checkbox
                      checked={allOnPageSelected}
                      aria-label="Select all on this page"
                      onCheckedChange={(checked) =>
                        setSelected(checked ? page.map((row) => row.name) : [])
                      }
                    />
                  </TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.map((row) => (
                  <TableRow key={row.name} data-state={selected.includes(row.name) ? 'selected' : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(row.name)}
                        aria-label={`Select ${row.title}`}
                        onCheckedChange={(checked) =>
                          setSelected((prev) =>
                            checked ? [...prev, row.name] : prev.filter((name) => name !== row.name),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                        onClick={() => setDetail(row)}
                      >
                        <span className="block truncate text-sm font-medium">{row.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.cls}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.state === 'indexed' ? 'success' : 'info'}>{row.state}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {row.chunks}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${row.title}`}>
                            <MoreHorizontal className="size-4" aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setDetail(row)}>Details</DropdownMenuItem>
                          <DropdownMenuItem>Open PDF</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive">Remove</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination
            offset={offset}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onOffsetChange={setOffset}
            rangeLabel={(from, to, total) => `${from}–${to} of ${total}`}
            previousLabel="Previous"
            nextLabel="Next"
          />
        </div>
      </SectionCard>

      <SectionCard title="Loading" description="One skeleton shape, not seven." loading skeletonRows={3} />
      <SectionCard
        title="Failed"
        description="One retry affordance, not seven."
        error
        errorMessage="Could not load base knowledge."
        onRetry={() => undefined}
      />
      <SectionCard
        title="Empty"
        description="A crafted invitation, not bare text."
        empty
        emptyIcon={BookOpenCheck}
        emptyTitle="No documents yet"
        emptyDescription="Upload a PDF to ground every project's answers on it."
      />

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent closeLabel="Close">
          <SheetHeader>
            <SheetTitle>{detail?.title}</SheetTitle>
            <SheetDescription>{detail?.name}</SheetDescription>
          </SheetHeader>
          <p className="text-sm text-muted-foreground">
            Row detail lives here — rename, reclassify, open, remove — instead of four controls crammed into every
            row of the table.
          </p>
        </SheetContent>
      </Sheet>
    </main>
  )
}
