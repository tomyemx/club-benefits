import { readFileSync } from 'node:fs';

/**
 * Merchant identity in two tiers (LLM Wiki p. 23, "fold by cost of a miss").
 *
 * Tier 1 is mechanical and only touches the orthography of one name: quotes,
 * hyphens, whitespace, a few generic leading words. Tier 2 is a human-edited
 * alias table, because "these two names are the same business" is a fact
 * about the world, not a string rule. Resolution is one hop and applied to
 * both the stored name and the query.
 *
 * There is deliberately no fuzzy matching: a fold that merges two true
 * variants also merges a third, distinct name (מודיעין / מודיעין עילית).
 */

// Generic words a listing puts in front of a brand. Not "קולנוע": in
// "קולנוע לב" it is part of the name.
const GENERIC_PREFIX = /^(?:רשת|אתר|שובר)\s+/;

export function foldName(raw: string): string {
  let s = raw
    .normalize('NFC')
    .replace(/["'״׳`]/g, '')
    .replace(/[-–—_]/g, ' ')
    .replace(/קריית/g, 'קרית')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Strip at most one generic prefix, and never down to nothing.
  const stripped = s.replace(GENERIC_PREFIX, '');
  if (stripped.length >= 2) s = stripped;
  return s;
}

export class AliasTable {
  private readonly map: Map<string, string>;

  constructor(pairs: Iterable<[alias: string, canonical: string]>) {
    this.map = new Map();
    for (const [alias, canonical] of pairs) {
      this.map.set(foldName(alias), foldName(canonical));
    }
  }

  /** CSV with a header row: alias,canonical. Lines starting with # are notes. */
  static fromCsv(text: string): AliasTable {
    const pairs: [string, string][] = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const [alias, canonical] = line.split(',').map((x) => x.trim());
      if (alias && canonical) pairs.push([alias, canonical]);
    }
    return new AliasTable(pairs);
  }

  static fromFile(path: string): AliasTable {
    return AliasTable.fromCsv(readFileSync(path, 'utf8'));
  }

  /** Canonical key for a raw name: fold, then one alias hop, never two. */
  key(raw: string): string {
    const folded = foldName(raw);
    return this.map.get(folded) ?? folded;
  }
}
