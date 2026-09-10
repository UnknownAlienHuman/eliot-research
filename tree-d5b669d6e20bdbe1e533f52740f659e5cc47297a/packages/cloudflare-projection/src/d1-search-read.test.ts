import assert from "node:assert/strict";
import { test } from "vitest";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { projectionDigest } from "./canonical.js";
import { isCandidateRead, isWatermarkRead, withSearchWorld, type SearchWorld } from "./d1-search-sqlite-fixture.js";

const incomplete = { code: "SEARCH_INCOMPLETE" };
const invalid = { code: "SEARCH_INPUT_INVALID" };
type Lane = "IDENT" | "LEX";
function read(world: SearchWorld, lane: Lane, request: RetrievalRequest) {
  return lane === "IDENT" ? world.ident.lookupIdentifiers(request) : world.lex.search(request, "LEX");
}
function mutableScope(request: RetrievalRequest): Record<string, unknown> {
  return request.scope_snapshot as unknown as Record<string, unknown>;
}
for (const lane of ["IDENT", "LEX"] as const) {
  test(`${lane}: unchanged hit and genuine no-hit remain bounded locators`, async () => {
    await withSearchWorld(async (w) => {
      const hits = await read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned"));
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.preview, "");
      assert.equal(hits[0]?.source_revision_ref, "rev-a");
      assert.equal(hits[0]?.index_generation, "generation-rev-a");
      assert.deepEqual(await read(w, lane, w.request("absent")), []);
    });
  });
  for (const change of ["stale", "purge", "rotateOwner"] as const) {
    test(`${lane}: no-hit must not hide ${change} during the read`, async () => {
      await withSearchWorld(async (w) => {
        w.hooks.afterRead = (observation) => { if (isCandidateRead(observation)) w[change](); };
        await assert.rejects(read(w, lane, w.request("absent")), incomplete);
      });
    });
  }
  test(`${lane}: no-hit must not hide an already conflicting owner`, async () => {
    await withSearchWorld(async (w) => {
      w.rotateOwner();
      await assert.rejects(read(w, lane, w.request("absent")), incomplete);
    });
  });
  test(`${lane}: all scope members are settled even when the result limit is reached`, async () => {
    await withSearchWorld(async (w) => {
      w.hooks.afterRead = (observation) => {
        if (isCandidateRead(observation) && observation.args[0] === "rev-a") w.stale("rev-b");
      };
      await assert.rejects(read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned", 1)), incomplete);
    }, ["rev-a", "rev-b"]);
  });
  test(`${lane}: expiry during asynchronous final readback is rejected`, async () => {
    await withSearchWorld(async (w) => {
      let watermarkReads = 0;
      w.hooks.afterRead = (observation) => {
        if (isWatermarkRead(observation) && ++watermarkReads === 2) w.clock.now = w.expiry;
      };
      await assert.rejects(read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned")), incomplete);
    });
  });
  test(`${lane}: source already purged before the read contributes no locator`, async () => {
    await withSearchWorld(async (w) => {
      w.purge();
      assert.deepEqual(await read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned")), []);
    });
  });
  test(`${lane}: genuine empty scope does not query storage`, async () => {
    await withSearchWorld(async (w) => {
      const request = w.request("Pinned");
      Object.assign(mutableScope(request), { member_source_revision_refs: [], source_owner_generations: {} });
      assert.deepEqual(await read(w, lane, request), []);
      assert.equal(w.observations.length, 0);
    });
  });
  test(`${lane}: expired scope and unavailable/stale index remain different outcomes`, async () => {
    await withSearchWorld(async (w) => {
      w.clock.now = w.expiry;
      await assert.rejects(read(w, lane, w.request("Pinned")), { code: "SEARCH_UNAVAILABLE" });
      w.clock.now -= 1;
      w.stale();
      await assert.rejects(read(w, lane, w.request("Pinned")), incomplete);
      w.search.exec("DELETE FROM projection_watermark");
      await assert.rejects(read(w, lane, w.request("Pinned")), { code: "SEARCH_UNAVAILABLE" });
    });
  });
  for (const members of [null, undefined, "rev-a", 1, {}]) {
    test(`${lane}: malformed membership ${JSON.stringify(members)} cannot become valid-empty`, async () => {
      await withSearchWorld(async (w) => {
        const request = w.request("Pinned");
        mutableScope(request).member_source_revision_refs = members;
        await assert.rejects(read(w, lane, request), incomplete);
        assert.equal(w.observations.length, 0);
      });
    });
  }
  for (const query of [" ".repeat(513) + "Pinned", "a".repeat(513), "я".repeat(257), "😀".repeat(129), "a\ud800", "a\udc00"]) {
    test(`${lane}: rejects raw byte/Unicode overflow ${JSON.stringify(query).slice(0, 25)} len=${query.length}`, async () => {
      await withSearchWorld(async (w) => {
        await assert.rejects(read(w, lane, w.request(query)), invalid);
        assert.equal(w.observations.length, 0);
      });
    });
  }
  for (const query of ["a".repeat(512), "я".repeat(256), "😀".repeat(128)]) {
    test(`${lane}: accepts exact 512-byte query bound codepoint=${query.codePointAt(0)}`, async () => {
      await withSearchWorld(async (w) => { assert.deepEqual(await read(w, lane, w.request(query)), []); });
    });
  }
  for (const limit of [0, 51, -1, 1.5, NaN, Infinity]) {
    test(`${lane}: rejects invalid limit ${limit}`, async () => {
      await withSearchWorld(async (w) => {
        await assert.rejects(read(w, lane, w.request("Pinned", limit)), invalid);
        assert.equal(w.observations.length, 0);
      });
    });
  }
  for (const now of [NaN, Infinity, -Infinity]) {
    test(`${lane}: a nonfinite clock cannot authorize a read (${now})`, async () => {
      await withSearchWorld(async (w) => {
        w.clock.now = now;
        await assert.rejects(read(w, lane, w.request("absent")), incomplete);
      });
    });
  }
}

test("IDENT: nonidentifier fast-empty still settles its pinned generation", async () => {
  await withSearchWorld(async (w) => {
    w.hooks.afterRead = (observation) => {
      if (observation.sql.includes("JOIN projection_span s")) w.stale();
    };
    await assert.rejects(w.ident.lookupIdentifiers(w.request("!!!")), incomplete);
  });
});
test("IDENT: nonidentifier fast-empty cannot outlive its scope", async () => {
  await withSearchWorld(async (w) => {
    w.hooks.afterRead = (observation) => { if (isWatermarkRead(observation)) w.clock.now = w.expiry; };
    await assert.rejects(w.ident.lookupIdentifiers(w.request("!!!")), incomplete);
  });
});
test("LEX: query operators remain literal and read-only", async () => {
  await withSearchWorld(async (w) => {
    for (const query of ['Pinned" OR "1"="1', "OR *"]) {
      assert.deepEqual(await w.lex.search(w.request(query), "LEX"), []);
    }
    assert.equal(w.search.prepare("SELECT COUNT(*) AS n FROM projection_item").get()?.n, 1);
  });
});
test("IDENT: scope expiry is captured before awaits, not extended by a mutable request", async () => {
  await withSearchWorld(async (w) => {
    const request = w.request("item-rev-a");
    w.hooks.afterRead = (observation) => {
      if (isCandidateRead(observation)) {
        w.clock.now = w.expiry;
        mutableScope(request).expires_at = new Date(w.expiry + 60_000).toISOString();
      }
    };
    await assert.rejects(w.ident.lookupIdentifiers(request), incomplete);
  });
});
test("IDENT: owner binding cannot be replaced by mutating the request during the read", async () => {
  await withSearchWorld(async (w) => {
    const request = w.request("item-rev-a");
    w.hooks.afterRead = (observation) => {
      if (!isCandidateRead(observation)) return;
      w.core.exec("UPDATE source_revision SET source_owner_generation = 'owner-2'");
      w.rotateOwner();
      (mutableScope(request).source_owner_generations as Record<string, string>)["rev-a"] = "owner-2";
    };
    await assert.rejects(w.ident.lookupIdentifiers(request), incomplete);
  });
});
test("IDENT: a matching receipt reference cannot hide changed item-set identity", async () => {
  await withSearchWorld(async (w) => {
    const updatedDigest = await projectionDigest([
      { item_key: "item-rev-a", canonical_section_id: "section-rev-a", content_sha256: "f".repeat(64), start: 0, end: 19 },
    ]);
    w.hooks.afterRead = (observation) => {
      if (!isCandidateRead(observation)) return;
      w.search.prepare("UPDATE projection_item SET content_sha256 = ?").run("f".repeat(64));
      w.search.exec("UPDATE projection_span SET normalized_end_byte = 19");
      w.search.prepare("UPDATE projection_generation_receipt SET item_set_digest = ?").run(updatedDigest);
    };
    await assert.rejects(w.ident.lookupIdentifiers(w.request("item-rev-a")), incomplete);
  });
});

for (const lane of ["IDENT", "LEX"] as const) {
  for (const [index, owners] of [null, undefined, [], {}, Object.create({ "rev-a": "owner-1" })].entries()) {
    test(`${lane}: missing, malformed or inherited owner binding fails before storage: case ${index}`, async () => {
      await withSearchWorld(async (w) => {
        const request = w.request("absent");
        mutableScope(request).source_owner_generations = owners;
        await assert.rejects(read(w, lane, request), incomplete);
        assert.equal(w.observations.length, 0);
      });
    });
  }
  for (const scope of [null, undefined, [], "scope"]) {
    test(`${lane}: malformed scope container fails closed: ${String(scope)}`, async () => {
      await withSearchWorld(async (w) => {
        const request = { ...w.request("absent"), scope_snapshot: scope } as unknown as RetrievalRequest;
        await assert.rejects(read(w, lane, request), incomplete);
        assert.equal(w.observations.length, 0);
      });
    });
  }
  for (const members of [["rev-a", "rev-a"], ["bad space"], [null], Array(2)]) {
    test(`${lane}: invalid member set fails closed: ${JSON.stringify(members)}`, async () => {
      await withSearchWorld(async (w) => {
        const request = w.request("absent");
        mutableScope(request).member_source_revision_refs = members;
        await assert.rejects(read(w, lane, request), incomplete);
      });
    });
  }
  test(`${lane}: exact 64-member scope and 50-result bounds work; 65 members reject before reads`, async () => {
    const revisions = Array.from({ length: 64 }, (_, index) => `rev-${String(index).padStart(2, "0")}`);
    await withSearchWorld(async (w) => {
      const request = w.request(lane === "IDENT" ? "item-rev-00" : "Pinned", 50);
      const hits = await read(w, lane, request);
      assert.equal(hits.length, lane === "IDENT" ? 1 : 50);
      assert.ok(hits.every((hit) => hit.preview === ""));
      const before = w.observations.length;
      mutableScope(request).member_source_revision_refs = [...revisions, "rev-64"];
      await assert.rejects(read(w, lane, request), invalid);
      assert.equal(w.observations.length, before);
    }, revisions);
  });
  test(`${lane}: unrelated member owner change cannot hide behind another member's hit`, async () => {
    await withSearchWorld(async (w) => {
      w.hooks.afterRead = (observation) => {
        if (isCandidateRead(observation) && observation.args[0] === "rev-a") w.rotateOwner("rev-b");
      };
      await assert.rejects(read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned", 1)), incomplete);
    }, ["rev-a", "rev-b"]);
  });
  test(`${lane}: stable mixed LIVE/PURGED scope keeps only live locators`, async () => {
    await withSearchWorld(async (w) => {
      w.purge("rev-b");
      const hits = await read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned"));
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.source_revision_ref, "rev-a");
    }, ["rev-a", "rev-b"]);
  });
  test(`${lane}: corrupt generation digest cannot be disguised as valid-empty`, async () => {
    await withSearchWorld(async (w) => {
      w.search.prepare("UPDATE projection_generation_receipt SET item_set_digest = ?").run("0".repeat(64));
      await assert.rejects(read(w, lane, w.request("absent")), incomplete);
    });
  });
  test(`${lane}: partial scope without a watermark is incomplete, not empty`, async () => {
    await withSearchWorld(async (w) => {
      w.search.exec("DELETE FROM projection_watermark WHERE source_revision_ref = 'rev-b'");
      await assert.rejects(read(w, lane, w.request("absent")), incomplete);
    }, ["rev-a", "rev-b"]);
  });
}

function addSpanlessItem(world: SearchWorld, active = 1): void {
  world.search.prepare(
    "INSERT INTO projection_item " +
      "SELECT 'orphan-rev-a', source_revision_ref, 'orphan-section', content_sha256, " +
      "projection_generation, ? FROM projection_item WHERE item_key = 'item-rev-a'",
  ).run(active);
  world.search.prepare("INSERT INTO section_fts VALUES (?, ?)").run("orphan-rev-a", "Orphan");
}

for (const lane of ["IDENT", "LEX"] as const) {
  for (const query of [lane === "IDENT" ? "orphan-rev-a" : "Orphan", "absent"]) {
    test(`${lane}: an active item without a span invalidates the generation (${query})`, async () => {
      await withSearchWorld(async (w) => {
        addSpanlessItem(w);
        await assert.rejects(read(w, lane, w.request(query)), incomplete);
        assert.ok(!w.observations.some(isCandidateRead));
      });
    });
  }
  test(`${lane}: settlement detects a spanless active item added after the candidate read`, async () => {
    await withSearchWorld(async (w) => {
      w.hooks.afterRead = (observation) => {
        if (isCandidateRead(observation)) addSpanlessItem(w);
      };
      await assert.rejects(read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned")), incomplete);
    });
  });
  test(`${lane}: an inactive spanless item does not invalidate the active generation`, async () => {
    await withSearchWorld(async (w) => {
      addSpanlessItem(w, 0);
      const hits = await read(w, lane, w.request(lane === "IDENT" ? "item-rev-a" : "Pinned"));
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.candidate_id, "item-rev-a");
      assert.deepEqual(await read(w, lane, w.request(lane === "IDENT" ? "orphan-rev-a" : "Orphan")), []);
    });
  });
}
