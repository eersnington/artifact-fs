import type {
  ArtifactRunSession,
  RunIndex,
  RunIndexEntry,
} from "../core/types.js";
import { RUN_INDEX_PATH } from "../git/layout.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export async function readRunIndex(
  session: ArtifactRunSession,
): Promise<RunIndex> {
  const bytes = await session.readFile(RUN_INDEX_PATH);
  if (bytes === null) {
    return { schemaVersion: 1, entries: [] };
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as RunIndex;
    return { schemaVersion: 1, entries: parsed.entries ?? [] };
  } catch {
    // A corrupt index must not block new commits; manifests remain the
    // source of truth and the index is rebuilt additively from here on.
    return { schemaVersion: 1, entries: [] };
  }
}

export function appendIndexEntry(
  index: RunIndex,
  entry: RunIndexEntry,
): Uint8Array {
  const next: RunIndex = {
    schemaVersion: 1,
    entries: [...index.entries, entry],
  };
  return encoder.encode(JSON.stringify(next, null, 2) + "\n");
}
