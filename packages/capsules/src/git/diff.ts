/**
 * Tree-level diff between two path->bytes snapshots. Used by tests and by
 * tooling that inspects memory-layer runs; Git-backed layers get the same
 * information from `git diff base..head`.
 */
export type TreeDiff = {
  readonly added: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
};

export function computeTreeDiff(
  base: ReadonlyMap<string, Uint8Array>,
  head: ReadonlyMap<string, Uint8Array>,
): TreeDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, bytes] of head) {
    const previous = base.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (!bytesEqual(previous, bytes)) {
      modified.push(path);
    }
  }
  for (const path of base.keys()) {
    if (!head.has(path)) {
      removed.push(path);
    }
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
