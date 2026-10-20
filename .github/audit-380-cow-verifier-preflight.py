from pathlib import Path

path = Path("packages/cloudflare-research/src/artifact-cow-section-producer.ts")
text = path.read_text(encoding="utf-8")

old = '''    await dependencies.validate_evidence_classes({ contract, claims: normalized.claims, evidence_pack: pack });
    const cited = await validateCitedEvidence(normalized.cited_handle_refs, pack, parent, dependencies.resolve_current_evidence);
    const auditInputBytes = canonicalBytes({
      protocol: "eliotr.artifact-section-independent-verification-input.v1",
      operation_id: dependencies.attempt.request.operation_id,
      contract,
      section_text: normalized.section_text,
      claims: normalized.claims,
      cited_evidence: cited,
      evidence_pack_ref: pack.pack_ref,
      freeze_ref: parent.freeze.freeze_ref,
    });
    const verificationCall = await dependencies.execute(modelContext(dependencies, "INDEPENDENT_VERIFY", auditInputBytes));
    verificationOutput = verificationCall;
    const expectedInputSha = await evidenceSha256Bytes(auditInputBytes);
    const semanticBatch = decodeSemanticVerifierBatch((await decodeModelGatewayBody(verificationCall.bytes, verificationApi)).assistant_content, {
      verifier_ref: dependencies.verifier.verifier_ref,
      verifier_schema_generation: dependencies.verifier.schema_generation,
      evidence_input_sha256: expectedInputSha,
      claims: normalized.claims as never,
    });
    const trusted = dependencies.trusted_audit_inputs({ claims: normalized.claims, evidence_pack: pack });
    if (trusted.length !== normalized.claims.length || trusted.some((item, index) =>
      !sameRef(item.claim.claim_ref, normalized.claims[index]?.claim_ref ?? { id: "", revision: 0 }))) {
      fail("trusted independent-verifier inputs do not exactly cover normalized claims");
    }
    const translated = translateSemanticVerifierBatch(semanticBatch, trusted);
    const bodyBytes = new TextEncoder().encode(normalized.section_text);
    const bodySha = await evidenceSha256Bytes(bodyBytes);
    if (bodyBytes.byteLength > contract.maximum_utf8_bytes) fail("normalized section exceeds its contract byte limit");
'''
new = '''    await dependencies.validate_evidence_classes({ contract, claims: normalized.claims, evidence_pack: pack });
    const cited = await validateCitedEvidence(normalized.cited_handle_refs, pack, parent, dependencies.resolve_current_evidence);
    const bodyBytes = new TextEncoder().encode(normalized.section_text);
    if (bodyBytes.byteLength > contract.maximum_utf8_bytes) fail("normalized section exceeds its contract byte limit");
    const bodySha = await evidenceSha256Bytes(bodyBytes);
    const trusted = dependencies.trusted_audit_inputs({ claims: normalized.claims, evidence_pack: pack });
    if (trusted.length !== normalized.claims.length || trusted.some((item, index) =>
      !sameRef(item.claim.claim_ref, normalized.claims[index]?.claim_ref ?? { id: "", revision: 0 }))) {
      fail("trusted independent-verifier inputs do not exactly cover normalized claims");
    }
    const auditInputBytes = canonicalBytes({
      protocol: "eliotr.artifact-section-independent-verification-input.v1",
      operation_id: dependencies.attempt.request.operation_id,
      contract,
      section_text: normalized.section_text,
      claims: normalized.claims,
      cited_evidence: cited,
      evidence_pack_ref: pack.pack_ref,
      freeze_ref: parent.freeze.freeze_ref,
    });
    const verificationCall = await dependencies.execute(modelContext(dependencies, "INDEPENDENT_VERIFY", auditInputBytes));
    verificationOutput = verificationCall;
    const expectedInputSha = await evidenceSha256Bytes(auditInputBytes);
    const semanticBatch = decodeSemanticVerifierBatch((await decodeModelGatewayBody(verificationCall.bytes, verificationApi)).assistant_content, {
      verifier_ref: dependencies.verifier.verifier_ref,
      verifier_schema_generation: dependencies.verifier.schema_generation,
      evidence_input_sha256: expectedInputSha,
      claims: normalized.claims as never,
    });
    const translated = translateSemanticVerifierBatch(semanticBatch, trusted);
'''

count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one verifier block, found {count}")
path.write_text(text.replace(old, new), encoding="utf-8")
