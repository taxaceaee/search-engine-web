import type { Timing } from "./types";

/** Route-level time spent preparing the retrieval corpus. */
export function corpusTimingMs(timing?: Timing | null) {
  return (
    (timing?.notebookLookupMs ?? 0) +
    (timing?.corpusLoadMs ?? 0) +
    (timing?.corpusMergeMs ?? 0)
  );
}

/** Additive top-level buckets. Component timings may overlap in wall time. */
export function topLevelTimingMs(timing?: Timing | null) {
  return (
    corpusTimingMs(timing) +
    (timing?.queryProcessMs ?? 0) +
    (timing?.rankMs ?? timing?.retrieveMs ?? 0) +
    (timing?.packMs ?? 0) +
    (timing?.generateMs ?? 0)
  );
}
