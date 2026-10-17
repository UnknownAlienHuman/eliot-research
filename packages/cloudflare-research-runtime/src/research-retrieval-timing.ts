import type { RetrievalLane } from "@eliotr/contracts";

export type ResearchRetrievalTimingPhase =
  | "stage_setup"
  | "lane_preflight"
  | "lane"
  | "locator_mapping"
  | "evidence_resolution"
  | "currentness"
  | "finalize_io"
  | "stage_finalize"
  | "service_total"
  | "stage_handler";

export type ResearchRetrievalTimingLane = Extract<RetrievalLane, "IDENT" | "LEX" | "SEM">;

export interface ResearchRetrievalTimingSample {
  readonly phase: ResearchRetrievalTimingPhase;
  readonly duration_ms: number;
  readonly succeeded: boolean;
  readonly lane?: ResearchRetrievalTimingLane;
}

export interface ResearchRetrievalTimingSink {
  record(sample: ResearchRetrievalTimingSample): void;
}

export interface ResearchRetrievalTimingRecorder extends ResearchRetrievalTimingSink {
  flush(): void;
}

interface TimingBucket {
  readonly phase: ResearchRetrievalTimingPhase;
  readonly lane?: ResearchRetrievalTimingLane;
  duration_ms: number;
  calls: number;
  succeeded: boolean;
}

const MAX_PHASE_DURATION_MS = 600_000;
const MAX_PHASE_CALLS = 512;
const MAX_PHASE_BUCKETS = 16;
const TIMING_PHASES: readonly ResearchRetrievalTimingPhase[] = [
  "stage_setup", "lane_preflight", "lane", "locator_mapping", "evidence_resolution",
  "currentness", "finalize_io", "stage_finalize", "service_total", "stage_handler",
];
const TIMING_LANES: readonly ResearchRetrievalTimingLane[] = ["IDENT", "LEX", "SEM"];

function boundedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_PHASE_DURATION_MS, Math.max(0, Math.round(value)));
}

function safeOperationId(value: string): string {
  return value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : "invalid-operation";
}

export function createResearchRetrievalTimingRecorder(
  operationId: string,
  write: (line: string) => void = (line) => console.warn(line),
): ResearchRetrievalTimingRecorder {
  const buckets = new Map<string, TimingBucket>();
  let flushed = false;

  return Object.freeze({
    record(sample: ResearchRetrievalTimingSample): void {
      if (flushed || !TIMING_PHASES.includes(sample.phase)) return;
      const lanePhase = sample.phase === "lane" || sample.phase === "lane_preflight";
      if ((lanePhase && (sample.lane === undefined || !TIMING_LANES.includes(sample.lane))) ||
          (!lanePhase && sample.lane !== undefined)) return;

      const key = lanePhase ? `${sample.phase}:${sample.lane}` : sample.phase;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        if (buckets.size >= MAX_PHASE_BUCKETS) return;
        bucket = {
          phase: sample.phase,
          ...(sample.lane === undefined ? {} : { lane: sample.lane }),
          duration_ms: 0,
          calls: 0,
          succeeded: true,
        };
        buckets.set(key, bucket);
      }
      bucket.duration_ms = Math.min(MAX_PHASE_DURATION_MS, bucket.duration_ms + boundedDuration(sample.duration_ms));
      bucket.calls = Math.min(MAX_PHASE_CALLS, bucket.calls + 1);
      bucket.succeeded = bucket.succeeded && sample.succeeded;
    },

    flush(): void {
      if (flushed) return;
      flushed = true;
      const phases = [...buckets.values()]
        .sort((left, right) => {
          const leftPhase = TIMING_PHASES.indexOf(left.phase);
          const rightPhase = TIMING_PHASES.indexOf(right.phase);
          if (leftPhase !== rightPhase) return leftPhase - rightPhase;
          return (left.lane ?? "").localeCompare(right.lane ?? "");
        })
        .map((bucket) => ({
          phase: bucket.phase,
          ...(bucket.lane === undefined ? {} : { lane: bucket.lane }),
          duration_ms: bucket.duration_ms,
          calls: bucket.calls,
          succeeded: bucket.succeeded,
        }));
      try {
        write(JSON.stringify({
          event: "research_retrieval_phase_timing",
          protocol: "eliotr.research-retrieval-phase-timing.v1",
          stage: "RETRIEVE_BRANCHES",
          operation_id: safeOperationId(operationId),
          phases,
        }));
      } catch {
        // Telemetry must never change retrieval, authority or settlement behavior.
      }
    },
  });
}

export async function measureResearchRetrievalPhase<T>(
  sink: ResearchRetrievalTimingSink | undefined,
  phase: ResearchRetrievalTimingPhase,
  action: () => Promise<T>,
  lane?: ResearchRetrievalTimingLane,
): Promise<T> {
  if (sink === undefined) return action();
  const startedAt = Date.now();
  let succeeded = false;
  try {
    const result = await action();
    succeeded = true;
    return result;
  } finally {
    try {
      sink.record({ phase, duration_ms: Date.now() - startedAt, succeeded, ...(lane === undefined ? {} : { lane }) });
    } catch {
      // Timing collection is best-effort and cannot alter the retrieval outcome.
    }
  }
}
