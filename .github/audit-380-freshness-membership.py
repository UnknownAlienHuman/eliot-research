from pathlib import Path

path = Path("packages/cloudflare-navigation/src/source-revision-freshness.ts")
text = path.read_text(encoding="utf-8")

old_refs = '''  const refs = original.snapshot.member_source_revision_refs.map((ref) => identifier(ref, "saved source revision"));
  const profile = await readOwnerScopeProfile(database, original.snapshot);
  if (refs.length > profile.max_sources || new Set(refs).size !== refs.length) corrupt("saved Wiki scope source set is malformed");
'''
new_refs = '''  const refs = original.snapshot.member_source_revision_refs.map((ref) => identifier(ref, "saved source revision"));
  const refSet = new Set(refs);
  const profile = await readOwnerScopeProfile(database, original.snapshot);
  if (refs.length > profile.max_sources || refSet.size !== refs.length) corrupt("saved Wiki scope source set is malformed");
'''
old_member = '''    if (byRevision.has(savedRevisionRef) || !refs.includes(savedRevisionRef)) corrupt("Wiki source head identity is inconsistent");
'''
new_member = '''    if (byRevision.has(savedRevisionRef) || !refSet.has(savedRevisionRef)) corrupt("Wiki source head identity is inconsistent");
'''

for label, old, new in (("source set", old_refs, new_refs), ("membership check", old_member, new_member)):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact match, found {count}")
    text = text.replace(old, new)

path.write_text(text, encoding="utf-8")
