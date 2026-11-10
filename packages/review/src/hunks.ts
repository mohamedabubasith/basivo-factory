// The diff as the forge sees it, turned into "which lines can carry a comment". Built from the per-file patches
// the API returns (GitHub /pulls/N/files, GitLab /merge_requests/:iid/diffs), so it matches what the forge
// anchors inline comments on, and works on a depth-1 checkout.

export type FilePatch = {
  path: string
  previousPath: string | null // set on a rename
  status: 'added' | 'modified' | 'removed' | 'renamed'
  patch: string | null // null for binary or too-large files
}

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; oldLine: number | null; newLine: number | null; text: string }

export type FileHunks = {
  path: string
  previousPath: string | null
  status: FilePatch['status']
  binary: boolean
  lines: DiffLine[]
  newLines: Set<number> // commentable on the RIGHT side (added + context)
  oldLines: Set<number> // commentable on the LEFT side (deleted + context)
  added: number
  deleted: number
}

export type HunkMap = Map<string, FileHunks>

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldN = 0
  let newN = 0
  for (const raw of patch.split('\n')) {
    const h = HUNK.exec(raw)
    if (h) {
      oldN = Number(h[1])
      newN = Number(h[2])
      continue
    }
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    if (raw.startsWith('+')) lines.push({ kind: 'add', oldLine: null, newLine: newN++, text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', oldLine: oldN++, newLine: null, text: raw.slice(1) })
    else if (raw.startsWith(' ') || raw === '') lines.push({ kind: 'ctx', oldLine: oldN++, newLine: newN++, text: raw.slice(1) })
  }
  return lines
}

export function buildHunkMap(files: FilePatch[]): HunkMap {
  const map: HunkMap = new Map()
  for (const f of files) {
    const lines = f.patch ? parsePatch(f.patch) : []
    const entry: FileHunks = {
      path: f.path, previousPath: f.previousPath, status: f.status, binary: f.patch === null, lines,
      newLines: new Set(lines.filter(l => l.newLine !== null).map(l => l.newLine!)),
      oldLines: new Set(lines.filter(l => l.oldLine !== null).map(l => l.oldLine!)),
      added: lines.filter(l => l.kind === 'add').length,
      deleted: lines.filter(l => l.kind === 'del').length,
    }
    map.set(f.path, entry)
  }
  return map
}

export const changedLines = (map: HunkMap): number => [...map.values()].reduce((t, f) => t + f.added + f.deleted, 0)

export function lineInDiff(map: HunkMap, file: string, line: number, side: 'RIGHT' | 'LEFT'): boolean {
  const f = map.get(file)
  if (!f) return false
  return side === 'RIGHT' ? f.newLines.has(line) : f.oldLines.has(line)
}

// A quote counts as evidence only when it is in the file and says something: a lone brace, keyword or
// blank line can be "found" anywhere and proves nothing.
const TRIVIAL = /^[\s{}()[\];,]*$|^\s*(return|else|end|break|continue|pass|done|fi)\s*;?\s*$/

export const isTrivialEvidence = (evidence: string): boolean => evidence.trim().length < 4 || TRIVIAL.test(evidence.trim())

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

// Verbatim, whitespace-insensitive; multi-line quotes are matched against the squashed file.
export function evidenceExists(fileText: string, evidence: string): boolean {
  const needle = squash(evidence)
  return needle.length > 0 && squash(fileText).includes(needle)
}

// The line the evidence sits on in the file at head, when the finder's own line number is off by a little.
export function locateEvidence(fileText: string, evidence: string): number | null {
  const first = squash(evidence.split('\n').find(l => l.trim()) ?? '')
  if (!first) return null
  const lines = fileText.split('\n')
  const at = lines.findIndex(l => squash(l).includes(first))
  return at === -1 ? null : at + 1
}

// Unified diff of the whole change, for the agent to read as a file (the tools have no git).
export function renderDiff(map: HunkMap): string {
  const out: string[] = []
  for (const f of map.values()) {
    out.push(`--- ${f.previousPath ?? f.path}`, `+++ ${f.path}${f.binary ? ' (binary or too large; patch omitted)' : ''}`)
    let last: DiffLine | null = null
    for (const l of f.lines) {
      const jump = last && ((l.newLine ?? l.oldLine ?? 0) - (last.newLine ?? last.oldLine ?? 0) > 1)
      if (!last || jump) out.push(`@@ -${l.oldLine ?? '?'} +${l.newLine ?? '?'} @@`)
      out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)
      last = l
    }
    out.push('')
  }
  return out.join('\n')
}
