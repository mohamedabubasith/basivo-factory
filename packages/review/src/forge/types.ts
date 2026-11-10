// What the reviewer needs from a code host. GitHub and GitLab each implement it; the pipeline never sees which.

import type { FilePatch } from '../hunks.ts'

export type ChangeRequest = {
  number: number
  title: string
  body: string
  draft: boolean
  open: boolean
  author: string
  authorIsBot: boolean
  fromFork: boolean
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  url: string
}

export type CiStatus = { state: 'success' | 'failure' | 'pending' | 'none'; detail: string }

export type InlineComment = { path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }

export type PostResult = { posted: number; failed: InlineComment[] }

export interface Forge {
  readonly kind: 'github' | 'gitlab'
  readonly repo: string
  change(number: number): Promise<ChangeRequest>
  files(number: number): Promise<FilePatch[]>
  // Text of a file at a commit, null when it does not exist there (or is binary / too large).
  fileAt(path: string, ref: string): Promise<string | null>
  // Files under a directory at a ref, recursive; [] when the directory does not exist.
  listDir(path: string, ref: string): Promise<string[]>
  ciStatus(sha: string): Promise<CiStatus>
  // One review with inline comments. Anchors the host rejects come back in `failed` instead of failing the post.
  postInline(number: number, headSha: string, comments: InlineComment[]): Promise<PostResult>
  // The one summary comment the reviewer owns on this change: created once, then edited in place.
  upsertSummary(number: number, marker: string, body: string): Promise<string>
  // Fingerprints already posted inline on this change (from earlier runs), so a re-push does not repeat them.
  postedFingerprints(number: number): Promise<Set<string>>
}

export const FINGERPRINT_TAG = (fp: string) => `<!-- basivo-review fp=${fp} -->`
export const FINGERPRINT_RE = /<!-- basivo-review fp=([0-9a-f]{16}) -->/g
