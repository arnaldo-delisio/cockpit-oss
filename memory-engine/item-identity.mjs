// item-identity.mjs — the composite roadmap-item identity contract (ATT-4 §5, board-rethink-design).
//
// One canonical form, one hash, one key string, shared by every consumer (roadmap.mjs's
// near-duplicate refusal, decisions.mjs's item targets, the attention sidecar's record keys,
// the feed comparator's final tiebreak, the later rebind pass). Content hash alone is NOT the
// identity: identical task text in two projects of one scope must not collide, so the key is
// the COMPOSITE (scope, project id, 8-byte hash prefix). Pure functions, no I/O.

import { createHash } from 'node:crypto';

// Canonical form = item text minus the checkbox marker, minus `→ <pointer>` segments,
// whitespace collapsed, lowercased, trimmed (ATT-4 §5). Pointer stripping removes each `→`
// plus exactly ONE following token (non-whitespace, non-delimiter) so an item's identity
// survives pointer edits without eating substantive trailing prose ("→ x.md after review"
// keeps "after review").
export function canonicalItemText(raw) {
  return String(raw)
    .replace(/^- \[[ x]\] /, '')
    .replace(/→\s*[^\s,;]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,;:.!?])/g, '$1')   // a stripped mid-text pointer must not leave " ," behind
    .toLowerCase()
    .trim();
}

// sha256 of the canonical text, first 16 hex chars (= the spec's 8-byte prefix).
export function itemHash(canonical) {
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// THE key string. Everything that stores or joins on an item uses exactly this shape.
export function compositeItemKey(scope, projectId, hash) {
  return `${scope}/${projectId}/${hash}`;
}

// Token-set Jaccard similarity on canonical texts — the near-duplicate refusal metric
// (roadmap:add) and the rebind threshold metric (≥ 0.6, ATT-4 §5). Tokens are the
// whitespace-split words of the canonical form; duplicates within one text collapse (set
// semantics). Two empty token sets are identical (1), one empty set matches nothing (0).
export function tokenSetSimilarity(a, b) {
  const setA = new Set(canonicalItemText(a).split(' ').filter(Boolean));
  const setB = new Set(canonicalItemText(b).split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}
