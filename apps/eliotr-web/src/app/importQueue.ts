import type { ProjectSummary } from '@eliotr/owner-api-client';
import { freezeProjectAttachmentTarget, type ProjectAttachmentTarget } from '../query/projectAttachment';

export interface ImportQueueJob {
  readonly id: string;
  readonly file: File;
  readonly phase: 'waiting' | 'running' | 'complete';
}
export interface ImportQueue {
  readonly id: string;
  readonly namespace: string;
  readonly jobs: readonly ImportQueueJob[];
  readonly project?: ProjectSummary;
  readonly cancelled: boolean;
  readonly attachment?: { readonly owner: string; readonly target: ProjectAttachmentTarget };
}
export interface ImportQueueWorker {
  readonly file: File;
  readonly namespace: string;
  readonly memoryId: string;
  readonly position: number;
  readonly needsAttachment: boolean;
  readonly allowReplacement: boolean;
  readonly replaceFile: (file: File) => boolean;
  readonly attachmentPermit: () => ProjectAttachmentTarget | undefined;
  readonly confirmedProject: (project: ProjectSummary) => boolean;
  readonly finished: () => void;
}

/** Scheduling owns no import effects; each admitted slot reuses the existing per-file pipeline. */
export function startImportQueue(queue: ImportQueue): ImportQueue {
  if (queue.cancelled) return queue;
  let available = 2 - queue.jobs.filter(job => job.phase === 'running').length;
  if (available <= 0) return queue;
  let changed = false;
  const jobs = queue.jobs.map(job => {
    if (job.phase !== 'waiting' || available <= 0) return job;
    available--; changed = true;
    return { ...job, phase: 'running' as const };
  });
  return changed ? { ...queue, jobs } : queue;
}

/** The protected queue retains this permit, including across close/remount and unknown PUTs. */
export function claimImportAttachment(queue: ImportQueue, owner: string, generation: string): ImportQueue {
  if (queue.attachment || !queue.project || !queue.jobs.some(job => job.id === owner && job.phase === 'running')) return queue;
  return { ...queue, attachment: { owner, target: freezeProjectAttachmentTarget(queue.project, generation) } };
}

export function confirmImportAttachment(queue: ImportQueue, owner: string, project: ProjectSummary): ImportQueue {
  const held = queue.attachment;
  if (!held || held.owner !== owner || project.project_id !== held.target.projectId ||
      project.title !== held.target.title || project.revision < held.target.revision ||
      !held.target.sourceIds.every(id => project.source_ids.includes(id))) return queue;
  const { attachment: _attachment, ...rest } = queue;
  return { ...rest, project };
}

export function finishImportQueueJob(queue: ImportQueue, id: string): ImportQueue {
  if (queue.attachment?.owner === id || !queue.jobs.some(job => job.id === id && job.phase === 'running')) return queue;
  return { ...queue, jobs: queue.jobs.map(job => job.id === id ? { ...job, phase: 'complete' } : job) };
}
