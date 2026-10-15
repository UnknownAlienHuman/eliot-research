import { indexProjectSources } from "@eliotr/cloudflare-ai/project-search";
import type { ProjectMembershipIndexMutationInput } from "@eliotr/cloudflare-navigation";
import {
  DeliveryRuntimeError,
  prepareIntentWithOutboxMutation,
  sha256Utf8,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";

export const PROJECT_MEMBERSHIP_INDEX_TOPIC = "project.membership.index.v1" as const;

const MAX_PROJECT_SOURCES = 256;
const PROJECT_INDEX_REF = /^project-membership-index-v1-(project-[a-f0-9]{48})-([1-9][0-9]{0,15})-([a-f0-9]{64})$/u;

export async function prepareProjectMembershipIndexOutboxPlan(
  database: D1Database,
  mutation: ProjectMembershipIndexMutationInput,
) {
  const payloadRef =
    `project-membership-index-v1-${mutation.project_id}-${mutation.project_revision}-${mutation.request_sha256}`;
  const intent = {
    intent_ref: {
      id: `project-membership-index-${mutation.project_id}-${mutation.project_revision}-${mutation.request_sha256.slice(0, 32)}`,
      revision: 1,
    },
    operation_kind: "PROJECTION" as const,
    principal_ref: mutation.principal_ref,
    idempotency_key: payloadRef,
    payload_ref: payloadRef,
    policy_decision_ref: `project-mutation-${mutation.request_sha256}`,
    created_at: mutation.created_at,
  };

  return prepareIntentWithOutboxMutation(database, {
    intent,
    topic: PROJECT_MEMBERSHIP_INDEX_TOPIC,
    payload_sha256: await sha256Utf8(payloadRef),
  }, {
    insert_guard: {
      predicate_sql:
        "EXISTS (SELECT 1 FROM project_mutation_receipt r WHERE r.principal_ref=?11 " +
        "AND r.idempotency_key=?12 AND r.operation=?13 AND r.project_id=?14 " +
        "AND r.request_sha256=?15 AND r.project_revision=?16)",
      bindings: [
        mutation.mutation_principal_ref,
        mutation.mutation_idempotency_key,
        mutation.operation,
        mutation.project_id,
        mutation.request_sha256,
        mutation.project_revision,
      ],
    },
  });
}

interface ProjectMembershipIndexIdentity {
  readonly project_id: string;
  readonly project_revision: number;
  readonly request_sha256: string;
}

function decodeMembershipIndexRef(message: Parameters<DeliveryHandler>[0]): ProjectMembershipIndexIdentity {
  if (message.topic !== PROJECT_MEMBERSHIP_INDEX_TOPIC || message.idempotency_key !== message.payload_ref) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "project membership-index delivery identity is invalid");
  }
  const match = PROJECT_INDEX_REF.exec(message.payload_ref);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "project membership-index reference is invalid");
  }
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "project mutation revision is invalid");
  }
  return { project_id: match[1], project_revision: revision, request_sha256: match[3] };
}

interface DeliveryAuthorityRow {
  readonly intent_principal_ref: unknown;
  readonly current_owner_principal_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly has_previous_receipt: unknown;
}

async function currentProjectOwner(
  env: Env,
  message: Parameters<DeliveryHandler>[0],
  identity: ProjectMembershipIndexIdentity,
): Promise<string | null> {
  const row = await env.CORE_DB.prepare(
    "SELECT i.principal_ref AS intent_principal_ref,po.principal_ref AS current_owner_principal_ref, " +
    "i.policy_decision_ref,EXISTS (SELECT 1 FROM project_mutation_receipt previous " +
    "WHERE previous.project_id=r.project_id AND previous.project_revision=r.project_revision-1) AS has_previous_receipt " +
    "FROM outbox o " +
    "JOIN operation_intent i ON i.intent_id=o.intent_id AND i.revision=o.intent_revision " +
    "JOIN project_mutation_receipt r ON r.project_id=?6 AND r.project_revision=?7 AND r.request_sha256=?8 " +
    "LEFT JOIN project_owner po ON po.project_id=r.project_id " +
    "WHERE o.outbox_id=?1 AND o.topic=?2 AND o.payload_ref=?3 AND o.payload_sha256=?4 " +
    "AND i.idempotency_key=?5 AND i.operation_kind='PROJECTION' " +
    "AND i.policy_decision_ref='project-mutation-'||r.request_sha256 " +
    "AND r.operation IN ('CREATE','UPDATE') LIMIT 1",
  ).bind(
    message.outbox_id,
    message.topic,
    message.payload_ref,
    message.payload_sha256,
    message.idempotency_key,
    identity.project_id,
    identity.project_revision,
    identity.request_sha256,
  ).first<DeliveryAuthorityRow>();
  if (row === null || typeof row.intent_principal_ref !== "string" ||
      row.policy_decision_ref !== `project-mutation-${identity.request_sha256}`) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "project membership-index D1 authority is unavailable");
  }
  if (row.current_owner_principal_ref !== row.intent_principal_ref) return null;
  if (identity.project_revision > 1 && row.has_previous_receipt !== 1) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "prior project mutation receipt is unavailable");
  }
  return row.intent_principal_ref;
}

interface CurrentMembershipRow {
  readonly source_id: unknown;
}

async function currentMembershipSources(
  env: Env,
  identity: ProjectMembershipIndexIdentity,
  principalRef: string,
): Promise<readonly string[]> {
  const observedAt = new Date().toISOString();
  const result = await env.CORE_DB.prepare(
    "SELECT m.source_id FROM project p " +
    "JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=?2 " +
    "JOIN project_mutation_receipt mutation ON mutation.project_id=p.project_id " +
    "AND mutation.project_revision=?3 AND mutation.request_sha256=?4 " +
    "JOIN json_each(mutation.response_json,'$.source_ids') added " +
    "JOIN project_source_membership m ON m.project_id=p.project_id AND m.source_id=added.value " +
    "JOIN source s ON s.source_id=m.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id AND r.source_revision_ref=s.head_rev " +
    "WHERE p.project_id=?1 AND m.valid_to IS NULL " +
    "AND (?3=1 OR EXISTS (SELECT 1 FROM project_mutation_receipt previous " +
    "WHERE previous.project_id=p.project_id AND previous.project_revision=mutation.project_revision-1)) " +
    "AND NOT EXISTS (SELECT 1 FROM project_mutation_receipt previous, " +
    "json_each(previous.response_json,'$.source_ids') prior " +
    "WHERE previous.project_id=p.project_id AND previous.project_revision=mutation.project_revision-1 " +
    "AND prior.value=added.value) " +
    "AND julianday(m.valid_from)<=julianday(?5) " +
    "AND r.purge_state='LIVE' AND r.source_owner_generation=s.source_owner_generation " +
    "ORDER BY m.source_id LIMIT ?6",
  ).bind(
    identity.project_id,
    principalRef,
    identity.project_revision,
    identity.request_sha256,
    observedAt,
    MAX_PROJECT_SOURCES + 1,
  ).all<CurrentMembershipRow>();
  if (!result.success || !Array.isArray(result.results)) {
    throw new Error("current project membership-index authority is unavailable");
  }
  if (result.results.length > MAX_PROJECT_SOURCES) {
    throw new Error("project membership-index source bound was exceeded");
  }
  const sourceIds = result.results.map((row) => {
    if (typeof row.source_id !== "string" || row.source_id.length === 0) {
      throw new Error("current project membership-index source identity is invalid");
    }
    return row.source_id;
  });
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("current project membership-index contains duplicate sources");
  }
  return Object.freeze(sourceIds);
}

/** Indexes only the source IDs added by this exact project mutation receipt. */
export function createProjectMembershipIndexDeliveryHandler(env: Env): DeliveryHandler {
  return async (message) => {
    const identity = decodeMembershipIndexRef(message);
    if (await sha256Utf8(message.payload_ref) !== message.payload_sha256) {
      throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "project membership-index digest is invalid");
    }
    const principalRef = await currentProjectOwner(env, message, identity);
    if (principalRef === null) {
      return { receipt_ref: `project-membership-index-${message.outbox_id}` };
    }
    const sourceIds = await currentMembershipSources(env, identity, principalRef);
    if (sourceIds.length > 0) {
      await indexProjectSources({
        namespace: env.AI_SEARCH,
        core_database: env.CORE_DB,
        search_database: env.SEARCH_DB,
        project_id: identity.project_id,
        source_ids: sourceIds,
      });
    }
    return { receipt_ref: `project-membership-index-${message.outbox_id}` };
  };
}
