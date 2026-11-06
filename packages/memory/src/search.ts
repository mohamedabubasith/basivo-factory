// A throwaway full-text index, rebuilt in each job from the memory branch's files. SQLite FTS5 ships with
// Node (node:sqlite), so there is nothing to install or host. Embeddings can come later if recall falls short.

import { DatabaseSync } from 'node:sqlite'

export type Doc = { id: string; text: string }
export type Hit = { id: string; score: number }

// Free text becomes an OR of quoted words, so punctuation in an error message can't break the FTS5 syntax.
export function toFtsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])]
  return words.length ? words.map(w => `"${w}"`).join(' OR ') : null
}

export function buildIndex(docs: Doc[]): { search(text: string, limit: number): Hit[] } {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, text)')
  const insert = db.prepare('INSERT INTO docs (id, text) VALUES (?, ?)')
  for (const doc of docs) insert.run(doc.id, doc.text)
  const query = db.prepare('SELECT id, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?')

  return {
    search(text, limit) {
      const fts = toFtsQuery(text)
      if (!fts) return []
      // bm25 is lower-is-better and negative; flip it so a bigger score means a better match.
      return query.all(fts, limit).map(row => ({ id: String(row.id), score: -Number(row.rank) }))
    },
  }
}
