# R2 object layout and lock policy

## `eliotr-evidence`

```text
objects/<residency-key-digest>/<prefix>/<content-digest>
manifests/source/<namespace>/<source>/<revision>.json
normalized/<residency-key-digest>/<artifact>/<revision>/full.md
normalized/<residency-key-digest>/<artifact>/<revision>/{structure,mappings,tables}.json
captures/{web,repository}/<residency-key-digest>/<source>/<revision>/
exports/conversation/<residency-key-digest>/<source>/<revision>/
tombstones/<purge-id>.json
```

## `eliotr-work`

```text
staging/<operation>/<attempt>/
projection/<generation>/<instance>/<project>/<item>.md
investigation/<id>/<revision>/
artifact/<id>/<revision>/{sections,manifest.json}
wiki/<page>/<revision>.{md,json}
draft/<project>/<draft>/<revision>.md
backup/<backup-epoch>/
quarantine/
purge-work/<purge-id>/
```

Bucket Lock is never enabled across the whole evidence bucket. Erasable prefixes receive no lock that
can outlive their deletion deadline. Legal holds and bounded lawful retention receive dedicated
prefix rules. A conflict yields `PURGE_BLOCKED`; no component may report physical deletion before
readback verifies absence at every required location.
