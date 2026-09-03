from pathlib import Path

path = Path("packages/cloudflare-ai/src/ai-search-provisioning.ts")
source = path.read_text(encoding="utf-8")
old = '''    const pageFingerprint = decoded.result.map((entry) => entry.id).join("\\u0000");
    if (decoded.result.length > 0 && pageFingerprints.has(pageFingerprint)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list repeated a page during pagination",
      );
    }
    pageFingerprints.add(pageFingerprint);
    for (const summary of decoded.result) {
      if (seenIds.has(summary.id)) {
        provisioningFailure(
          summary.id === spec.profile.id
            ? "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
            : "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
          `AI Search list returned duplicate instance ${summary.id}`,
        );
      }
      seenIds.add(summary.id);
      if (summary.id === spec.profile.id) matches.push(summary);
    }
'''
new = '''    for (const summary of decoded.result) {
      if (seenIds.has(summary.id)) {
        provisioningFailure(
          summary.id === spec.profile.id
            ? "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
            : "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
          `AI Search list returned duplicate instance ${summary.id}`,
        );
      }
      seenIds.add(summary.id);
      if (summary.id === spec.profile.id) matches.push(summary);
    }
    const pageFingerprint = decoded.result.map((entry) => entry.id).join("\\u0000");
    if (decoded.result.length > 0 && pageFingerprints.has(pageFingerprint)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list repeated a page during pagination",
      );
    }
    pageFingerprints.add(pageFingerprint);
'''
if source.count(old) != 1:
    raise SystemExit(f"expected one pagination ordering block, found {source.count(old)}")
path.write_text(source.replace(old, new, 1), encoding="utf-8")
