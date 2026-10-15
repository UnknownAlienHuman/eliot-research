import { expect } from "vitest";
import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import {
  AI_SEARCH_PRIMARY_NAMESPACE,
  aiSearchPhysicalProfileDigest,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  projectionDigest,
} from "@eliotr/cloudflare-projection";
import type {
  ManagedGenerationPromotionEvidenceAuthorityPort,
  ManagedGenerationPromotionTarget,
} from "@eliotr/cloudflare-projection/ai-search";
import {
  currentAuthority,
  desiredManifest,
  evidence,
  promotionAuthority,
} from "../../../packages/cloudflare-projection/src/managed-generation-promotion-evidence.test-support.js";

/**
 * Controlled promotion-reader inputs, adapted from the registry source fixtures.
 * Native local R2 stores these explicit fixture receipts; native SEARCH_DB and
 * the production registry service validate and persist every transition. The
 * donor's writer-hold fixture remains explicit: this is no provider inventory,
 * live T2/T3 qualification, or production Core-authority proof.
 */
export function createNativeTargetRegistryFixture(database: D1Database, bucket: R2Bucket) {
  const donor = promotionAuthority();
  const declaredAt = new Date(Date.now() - 300_000).toISOString();
  const receipts = new Map<string, { readonly manifest: string; readonly evidence: string }>();
  const targetKey = (target: ManagedGenerationPromotionTarget) => JSON.stringify([
    target.namespace, target.managed_instance_id, target.managed_generation, target.target_profile_identity_sha256,
  ]);
  const readReceipt = async (target: ManagedGenerationPromotionTarget, kind: "manifest" | "evidence") => {
    const refs = receipts.get(targetKey(target));
    if (refs === undefined) throw new Error("no controlled fixture authority for this exact target");
    const object = await bucket.get(refs[kind]);
    if (object === null) throw new Error("controlled fixture receipt is missing from native local R2");
    return object.json<unknown>();
  };
  const authority: ManagedGenerationPromotionEvidenceAuthorityPort = {
    ...donor.authority,
    readDesiredManifest: target => readReceipt(target, "manifest"),
    readCurrentEvidence: target => readReceipt(target, "evidence"),
    async readFreshCurrentAuthority(target, proof) {
      if (!receipts.has(targetKey(target))) throw new Error("unknown fixture target authority");
      return currentAuthority(proof, target, {
        checked_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      });
    },
  };
  const registry = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(database), { promotion_evidence: authority },
  );
  return {
    registry,
    async declare(profile: AiSearchInstanceProfile) {
      const target: ManagedGenerationPromotionTarget = {
        namespace: AI_SEARCH_PRIMARY_NAMESPACE,
        managed_instance_id: profile.id,
        managed_generation: profile.generation,
        target_profile_identity_sha256: await aiSearchPhysicalProfileDigest(profile),
      };
      const prefix = `native-fixture/managed-target-registry/${await projectionDigest(target)}`;
      const refs = { manifest: `${prefix}/manifest.json`, evidence: `${prefix}/evidence.json` };
      const manifest = desiredManifest({ as_of: declaredAt }, target);
      const proof = evidence({}, target, manifest);
      await bucket.put(refs.manifest, JSON.stringify(manifest));
      await bucket.put(refs.evidence, JSON.stringify(proof));
      receipts.set(targetKey(target), refs);
      await registry.declare({ namespace: target.namespace, profile, declared_at: declaredAt });
      return { target, refs };
    },
    async rejectForeignEvidence(input: { readonly target: ManagedGenerationPromotionTarget; readonly refs: { readonly evidence: string } }) {
      const before = await registry.read(input.target.namespace);
      const original = await bucket.get(input.refs.evidence);
      if (original === null) throw new Error("fixture evidence is missing");
      const bytes = await original.text();
      const raw = JSON.parse(bytes) as { target: ManagedGenerationPromotionTarget };
      await bucket.put(input.refs.evidence, JSON.stringify({
        ...raw, target: { ...raw.target, managed_instance_id: "foreign-fixture-instance" },
      }));
      try {
        await expect(registry.qualify(input.target.namespace, { generation: input.target.managed_generation }))
          .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_STALE" });
        expect(await registry.read(input.target.namespace)).toEqual(before);
      } finally {
        await bucket.put(input.refs.evidence, bytes);
      }
    },
  };
}
