/* global document: readonly */
import assert from "node:assert/strict";
import process from "node:process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { prepareLocal, removeHarnessOwned, executeLocal, executeLocalD1WithRetryAsync, wranglerArgs, ROOT } from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker } from "../../../scripts/lib/local-worker.mjs";
import { startOwnerBridge } from "../../../scripts/lib/local-owner-bridge.mjs";
import { reserveMiniflareForbiddenPorts } from "../../../scripts/lib/miniflare-port-guard.mjs";
import { OWNER_E2E_ISSUER, OWNER_E2E_AUDIENCE, OWNER_E2E_KID } from "./owner-e2e.mjs";
import { prepareOwnerArtifactSnapshot } from "./owner-artifact-snapshot.mjs";

async function durableCheckpoint(paths, manifest) {
  const directory = resolve(paths.persist, "v3", "d1", "miniflare-D1DatabaseObject");
  let result;
  for (const name of (await readdir(directory)).filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite")) {
    const database = new DatabaseSync(resolve(directory, name), { readOnly: true });
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_publication_receipt'").get()) continue;
      assert.equal(result, undefined, "Exactly one canonical Core database is expected");
      const receipts = database.prepare("SELECT * FROM artifact_publication_receipt ORDER BY publication_ref").all();
      assert.equal(receipts.length, manifest.publication === undefined ? 0 : 1);
      if (manifest.publication !== undefined) assert.equal(receipts[0].publication_ref, manifest.publication.receipt.publication_ref);
      const modelTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('research_model_attempt','research_model_output','research_model_spend_admission')").all();
      assert.equal(modelTables.length, 3, "All durable model effect ledgers must exist");
      const effects = Object.fromEntries(modelTables.map(({ name: table }) => {
        assert.match(table, /^[a-z_]+$/u); return [table, database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n];
      }));
      result = { receipts, effects };
    } finally { database.close(); }
  }
  assert.ok(result, "Actual persisted Core checkpoint must exist");
  const blobs = [];
  for (const item of manifest.storage) {
    const bytes = await readFile(resolve(paths.persist, "v3", item.resource, item.path));
    assert.equal(bytes.length, item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    blobs.push(item.sha256);
  }
  return { ...result, blobs };
}
async function assertMigrationLedgers(paths) {
  const migrationRoot = resolve(paths.persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const seenLedgers = [];
  for (const name of (await readdir(migrationRoot)).filter((item) => item.endsWith(".sqlite") && item !== "metadata.sqlite")) {
    const db = new DatabaseSync(resolve(migrationRoot, name), { readOnly: true });
    try {
      const isCore = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_publication_receipt'").get());
      const stream = isCore ? "core" : "search";
      const expected = (await readdir(resolve(ROOT, "infra/d1", stream, "migrations"))).filter((item) => item.endsWith(".sql")).sort();
      assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => row.name), expected);
      seenLedgers.push(stream);
    } finally { db.close(); }
  }
  assert.deepEqual(seenLedgers.sort(), ["core", "search"]);
}
async function prepareArtifactProfile(stateDirectory) {
  return prepareLocal({ stateDirectory, log: () => {}, execute: (args, options) => {
    if (args[1] === "d1" && args[2] === "migrations" && args[3] === "apply") return;
    return executeLocal(args, options);
  } });
}
function sqlText(value) { assert.equal(typeof value, "string"); return "'" + value.replaceAll("'", "''") + "'"; }
async function fixtureMutation(paths, sql) {
  const output = await executeLocalD1WithRetryAsync(wranglerArgs(paths, ["d1", "execute", "CORE_DB", "--command", sql, "--json"]),
    { capture: true, timeoutMs: 30000 });
  const statements = JSON.parse(output);
  assert.ok(Array.isArray(statements) && statements.length > 0, "Fixture mutation must return a JSON D1 result");
  return statements.flatMap((item) => {
    assert.equal(item.success, true, "Fixture mutation must succeed");
    assert.ok(Array.isArray(item.results), "Fixture mutation must return its selected rows");
    return item.results;
  });
}

export async function runOwnerArtifactBrowser(harness) {
  const runId = `artifact-${process.pid}-${Date.now()}`;
  const purgeRunId = runId + "-purge";
  const originalRunId = runId + "-original";
  const guard = await reserveMiniflareForbiddenPorts();
  let directory; let paths; let jwks; let worker; let bridge; let browser;
  let purgeDirectory; let purgePaths; let purgeWorker; let originalDirectory;
  const receipt = { protocol: "eliotr.owner-artifact-browser.v1", browser: "PENDING", restart: "PENDING",
    current_rights: "PENDING", source_purge: "PENDING", run_reopen: "PENDING", model_after_restart: "PENDING" };
  try {
    directory = await harness.createMarkedTempDirectory("eliotr-owner-e2e-artifact-", runId, "artifact-state");
    // Native Workerd applies both real migration streams before making the
    // accepted artifact. Do not migrate a disposable empty DB that is replaced
    // by that snapshot; verify the saved native migration ledgers below.
    paths = await prepareArtifactProfile(directory);
    const { privateKey, publicJwk } = await harness.createOwnerE2EKey();
    jwks = await harness.startJwksServer(publicJwk);
    await harness.applyOwnerE2EProfile(paths, jwks.url);
    const issuedAt = Math.floor(Date.now() / 1000);
    const identity = { principal_ref: "freeze-owner", credential_generation: `cf-access-jwt:${OWNER_E2E_KID}:${issuedAt}`,
      deployment_generation: paths.generation };
    let token = await harness.signOwnerToken(privateKey, { iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE],
      sub: identity.principal_ref, type: "app", iat: issuedAt, exp: issuedAt + 3600 });
    process.stdout.write("owner-e2e artifact phase=native-accepted-snapshot\n");
    let manifest = await prepareOwnerArtifactSnapshot(paths, identity);
    let artifactPath = "/api/v1/research/artifact/" + encodeURIComponent(manifest.artifact.id + ":" + manifest.artifact.revision);
    let section = manifest.publication.revision.sections[0];
    let sectionPath = artifactPath + "/sections/" + encodeURIComponent(section.section_ref.id + ":" + section.section_ref.revision) + "/reauthorize";
    await assertMigrationLedgers(paths);
    const baseCheckpoint = await durableCheckpoint(paths, manifest);
    const processIds = [];
    async function publicationRead(targetWorker = worker, targetManifest = manifest, targetArtifactPath = artifactPath,
      targetToken = token, phase = "artifact-publication-read") {
      const read = await harness.workerJson(targetWorker.origin, targetArtifactPath + "/publication",
        { token: targetToken, worker: targetWorker, phase });
      assert.equal(read.status, 200, "Real persisted publication read failed: " + JSON.stringify(read.data)?.slice(0, 500));
      assert.deepEqual(read.data.data.receipt, targetManifest.publication.receipt);
      assert.equal(read.data.data.revision.status, "ACCEPTED");
    }

    async function start() {
      worker = await startLocalWorker(paths); processIds.push(worker.diagnostics().pid);
      assert.ok(Number.isSafeInteger(processIds.at(-1)));
      if (manifest.publication !== undefined) await publicationRead();
      const history = await harness.workerJson(worker.origin, "/api/v1/research/runs", { token, worker, phase: "artifact-history-diagnostic" });
      if (manifest.profile === "original-report") {
        assert.equal(history.status, 200);
        const runs = history.data.data.runs.filter((entry) => entry.status.workflow_instance_id === manifest.run.operation_id);
        assert.equal(runs.length, 1, "Original REPORT must have a real run-history locator");
        const status = await harness.workerJson(worker.origin, "/api/v1/research/run/" + encodeURIComponent(manifest.run.operation_id),
          { token, worker, phase: "original-report-run-status" });
        assert.equal(status.status, 200); assert.deepEqual(status.data.data, manifest.run.status);
        assert.deepEqual(status.data.data.answer, { availability: "draft", artifact_ref: manifest.artifact });
        const artifact = await harness.workerJson(worker.origin, artifactPath, { token, worker, phase: "original-report-author-read" });
        assert.equal(artifact.status, 200); assert.deepEqual(artifact.data.data.artifact_ref, manifest.artifact);
      }
      process.stdout.write(JSON.stringify({ phase: "artifact-real-history", status: history.status, code: history.data?.code,
        runs: history.data?.data?.runs?.length, saved_drafts: history.data?.data?.saved_drafts?.map((draft) => draft.artifact_ref) }) + "\n");
    }
    async function action(name, successor, callback, extraPaths = []) {
      try {
        await harness.settleLedger(browser.page, browser);
        browser.registerOp({ kind: "harness-action", cause: "recovery-selection", scope: "document", sourceDoc: browser.currentDocId(),
          targetDoc: browser.currentDocId(), action: name, role: "catalog-read", from: browser.currentOp().id, successors: [successor] });
        browser.mintSlotsFor(browser.currentIssuance(), { origin: bridge.origin, extraPaths });
        await callback();
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`owner-e2e artifact action=${name} failed: ${detail}\n`);
        throw error;
      }
    }
    let extras = [["GET", "/api/v1/system/session"], ["GET", "/api/v1/research/runs"], ["POST", artifactPath + "/reauthorize"],
      ["GET", artifactPath + "/publication"], ["GET", artifactPath + "/publication/current"], ["POST", sectionPath]];
    async function browserRead(round) {
      const original = manifest.profile === "original-report";
      const acceptFresh = original && manifest.publication === undefined;
      const openAction = original ? "artifact-open-run" : "artifact-open-draft";
      const openSelector = original ? 'button[aria-label^="Open saved research from"]' : 'button[aria-label^="Open saved research draft"]';
      async function openRun() {
        const [response] = await Promise.all([
          browser.page.waitForResponse((read) => read.request().method() === "GET" && read.url() === bridge.origin +
            "/api/v1/research/run/" + encodeURIComponent(manifest.run.operation_id), { timeout: 15000 }),
          browser.page.locator(openSelector).first().click(),
        ]);
        assert.equal(response.status(), 200);
        const status = (await response.json()).data;
        assert.deepEqual(status, manifest.run.status);
        assert.deepEqual(status.answer, { availability: "draft", artifact_ref: manifest.artifact });
      }
      browser = await harness.launchPlaywright(runId);
      browser.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document", sourceDoc: browser.currentDocId(),
        targetDoc: browser.currentDocId() + 1, action: "goto-unauthenticated", role: "startup-probe",
        from: browser.currentOp().id, successors: ["goto-pairing", "framenavigated"] });
      browser.mintSlotsFor(browser.currentIssuance(), { origin: worker.origin });
      await browser.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
      await browser.page.waitForFunction(harness.shellReady, null, { timeout: 15000 });
      await harness.settleLedger(browser.page, browser);
      harness.assertUnauthLedger(browser, "artifact-unauthenticated", worker.origin);
      harness.assertNoPrivateStorage(await harness.readBrowserStorage(browser.page), "artifact-unauthenticated");
      browser.resetLedger();
      bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation, port: 0 });
      browser.adoptIssuance(browser.setRole(browser.currentIssuance(), "pair-action"));
      browser.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document", sourceDoc: browser.currentDocId(),
        targetDoc: browser.currentDocId() + 1, action: "goto-pairing", role: "pair-action", from: browser.currentOp().id,
        successors: ["click-connect", "framenavigated"] });
      browser.mintSlotsFor(browser.currentIssuance(), { origin: bridge.origin, extraPaths: extras });
      await browser.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await harness.settleLedger(browser.page, browser);
      browser.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document", sourceDoc: browser.currentDocId(),
        targetDoc: browser.currentDocId(), action: "click-connect", role: "pair-action", from: browser.currentOp().id,
        successors: ["artifact-history-refresh"] });
      browser.mintSlotsFor(browser.currentIssuance(), { origin: bridge.origin, extraPaths: extras });
      await browser.page.click("#connect"); await browser.page.waitForFunction(harness.shellReady, null, { timeout: 15000 });
      await action("artifact-history-refresh", openAction, async () => {
        await harness.showWorkspaceView(browser.page, "#research-card", "research", "artifact owner loop");
        await browser.page.locator("[data-research-history] > summary").click();
        await browser.page.locator("[data-research-history-refresh]").click();
        try { await browser.page.locator(openSelector).first().waitFor({ timeout: 15000 }); }
        catch (error) {
          process.stdout.write(JSON.stringify({ phase: "artifact-history-browser-diagnostic", status: await browser.page.locator("[data-research-history-status]").textContent(),
            rows: await browser.page.locator("[data-research-history-list]").textContent() }) + "\n");
          throw error;
        }
      }, extras);
      await action(openAction, acceptFresh ? "artifact-original-accept" : "artifact-section-open", async () => {
        if (acceptFresh) {
          const [absent] = await Promise.all([
            browser.page.waitForResponse((response) => response.request().method() === "GET" &&
              response.url() === bridge.origin + artifactPath + "/publication", { timeout: 15000 }),
            openRun(),
          ]);
          assert.equal(absent.status(), 404); assert.equal((await absent.json()).code, "ARTIFACT_PUBLICATION_NOT_FOUND");
        } else if (original) await openRun(); else await browser.page.locator(openSelector).first().click();
        await browser.page.waitForFunction((status) => document.querySelector(".research-draft-badge")?.textContent === status,
          acceptFresh ? "DRAFT" : "ACCEPTED", { timeout: 15000 });
        assert.equal(await browser.page.getByRole("button", { name: "Accept report", exact: true }).isDisabled(), !acceptFresh);
      }, extras);
      if (acceptFresh) {
        await action("artifact-original-accept", "artifact-original-reopen", async () => {
          const [accepted, absentHead] = await Promise.all([
            browser.page.waitForResponse((response) => response.request().method() === "POST" &&
              response.url() === bridge.origin + artifactPath + "/accept", { timeout: 15000 }),
            browser.page.waitForResponse((response) => response.request().method() === "GET" &&
              response.url() === bridge.origin + artifactPath + "/publication/current", { timeout: 15000 }),
            browser.page.waitForEvent("dialog", { timeout: 15000 }).then(async (dialog) => {
              assert.equal(dialog.type(), "confirm");
              assert.equal(dialog.message(), "Accept this exact report revision after reviewing its sections and sources?");
              await dialog.accept();
            }),
            browser.page.getByRole("button", { name: "Accept report", exact: true }).click(),
          ]);
          assert.equal(absentHead.status(), 404); assert.equal((await absentHead.json()).code, "ARTIFACT_PUBLICATION_NOT_FOUND");
          assert.equal(accepted.status(), 201);
          manifest.publication = (await accepted.json()).data;
          assert.equal(manifest.publication.revision.status, "ACCEPTED");
          assert.deepEqual(manifest.publication.revision.sections[0], section);
          await browser.page.waitForFunction(() => document.querySelector(".research-draft-badge")?.textContent === "ACCEPTED", null, { timeout: 15000 });
        }, extras);
        await action("artifact-original-reopen", "artifact-section-open", async () => {
          await browser.page.locator("[data-research-history-refresh]").click();
          await browser.page.locator(openSelector).first().waitFor({ timeout: 15000 });
          await openRun();
          await browser.page.waitForFunction(() => document.querySelector(".research-draft-badge")?.textContent === "ACCEPTED", null, { timeout: 15000 });
          assert.equal(await browser.page.getByRole("button", { name: "Accept report", exact: true }).isDisabled(), true);
        }, extras);
      }
      await action("artifact-section-open", "artifact-acceptance-check", async () => {
        const [opened] = await Promise.all([
          browser.page.waitForResponse((response) => response.request().method() === "POST" &&
            response.url() === bridge.origin + sectionPath, { timeout: 15000 }),
          browser.page.getByRole("button", { name: "Open section", exact: true }).first().click(),
        ]);
        assert.equal(opened.status(), 200);
        for (const name of ["x-eliotr-artifact-ref", "x-eliotr-section-ref", "x-eliotr-section-object-ref",
          "x-eliotr-section-sha256", "x-eliotr-deployment-generation", "content-length"]) {
          assert.ok(opened.headers()[name], `Actual browser section response must retain ${name}`);
        }
        const bytes = await opened.body();
        assert.equal(createHash("sha256").update(bytes).digest("hex"), section.body_sha256);
        assert.equal(bytes.toString("utf8"), manifest.section_text);
        await browser.page.locator(".research-section-body").waitFor({ timeout: 15000 });
        assert.equal(await browser.page.locator(".research-section-body").textContent(), manifest.section_text);
      }, extras);
      await action("artifact-acceptance-check", "artifact-health-refresh", async () => {
        await browser.page.getByRole("button", { name: "Check acceptance", exact: true }).click();
        await browser.page.waitForFunction(() => document.querySelector(".research-publication-status")?.textContent?.includes("ACCEPTED"), null, { timeout: 15000 });
      }, extras);
      await action("artifact-health-refresh", "artifact-health-refresh", async () => {
        const [freshHealth] = await Promise.all([
          browser.page.waitForResponse((response) => response.request().method() === "GET" &&
            response.url() === bridge.origin + "/api/v1/system/health", { timeout: 15000 }),
          browser.page.locator(".content-actions > button[data-refresh]").click(),
        ]);
        assert.equal(freshHealth.status(), 200); await freshHealth.finished();
        await browser.page.waitForFunction((generation) => document.querySelector("#app")?.dataset.healthReady === "true" &&
          document.querySelector("#app")?.dataset.healthGeneration === generation &&
          document.querySelector(".content-actions > button[data-refresh]")?.disabled === false, paths.generation, { timeout: 15000 });
        await harness.settleLedger(browser.page, browser);
        assert.equal(await browser.page.locator("[data-run-badge]").textContent(), "ACCEPTED");
        assert.equal(await browser.page.locator(".research-draft-badge").textContent(), "ACCEPTED");
      }, extras);
      await harness.settleLedger(browser.page, browser);
      const spec = harness.authedNetworkSpec(bridge.origin);
      const api = [...spec.api, ...extras.map(([method, path]) => ({ method, path,
        status: method === "POST" && path === artifactPath + "/accept" ? 201 : 200 })),
      ...(acceptFresh ? [artifactPath + "/publication", artifactPath + "/publication/current"].map((path) => ({ method: "GET", path, status: 404 })) : [])];
      harness.assertPhaseNetwork(browser, `artifact-browser-${round}`, { ...spec, api,
        mutations: [...spec.mutations, ...extras.filter(([method]) => method === "POST").map(([, path]) => path)],
        workerOrigins: [worker.origin, bridge.origin] });
      receipt[`browser_${round}`] = harness.summarizePhaseLedger(browser);
      assert.deepEqual(browser.pageErrors, []);
      const expectedConsole = acceptFresh ? [artifactPath + "/publication", artifactPath + "/publication/current"].map((path) =>
        "Failed to load resource: the server responded with a status of 404 (Not Found) @" + (bridge.origin + path).slice(0, 160)) : [];
      assert.deepEqual([...browser.consoleErrors].sort(), expectedConsole.sort(),
        "Only the two exact typed absence responses may log during first original REPORT acceptance");
      await browser.close(); browser = undefined; await bridge.close(); bridge = undefined;
    }
    await start(); await browserRead("before_restart"); receipt.browser = "PASS";
    assert.deepEqual(await durableCheckpoint(paths, manifest), baseCheckpoint);
    process.stdout.write("owner-e2e artifact phase=true-worker-process-restart\n");
    const oldWorker = worker; await oldWorker.stop(); assert.notEqual(oldWorker.diagnostics().exitCode, null);
    worker = undefined; await start(); assert.notEqual(processIds[0], processIds[1]);
    await browserRead("after_restart");
    assert.deepEqual(await durableCheckpoint(paths, manifest), baseCheckpoint);
    receipt.restart = "PASS (distinct Worker PIDs, same persistent D1/R2, exact receipt/section/blob readback)";
    receipt.model_after_restart = "PASS (model receipt counts and original blobs unchanged; local gateways disabled)";
    const policies = manifest.read_policy_keys;
    assert.ok(policies.length > 0);
    const policyKeys = policies.map((policy) => "(source_namespace_id=" + sqlText(policy.source_namespace_id) +
      " AND principal_ref=" + sqlText(policy.principal_ref) + " AND client_class=" + sqlText(policy.client_class) +
      " AND policy_ref=" + sqlText(policy.policy_ref) + " AND generation=" + policy.generation + ")").join(" OR ");
    const revokedRows = await fixtureMutation(paths, "UPDATE scope_read_policy SET state='REVOKED' WHERE state='ACTIVE' AND (" +
      policyKeys + ") RETURNING source_namespace_id,principal_ref,client_class,policy_ref,generation");
    const canonicalPolicyRows = (rows) => rows.map((policy) => [policy.source_namespace_id, policy.principal_ref,
      policy.client_class, policy.policy_ref, policy.generation])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(canonicalPolicyRows(revokedRows), canonicalPolicyRows(policies),
      "Revocation must return exactly the selected canonical policy rows");
    const denied = await harness.workerJson(worker.origin, artifactPath + "/publication", { token, worker, phase: "artifact-revoked-read" });
    assert.equal(denied.status, 404); assert.equal(denied.data.code, "ARTIFACT_DRAFT_READ_NOT_FOUND");
    receipt.current_rights = "PASS (real Worker refused the accepted artifact after exact read-policy revocation)";
    assert.deepEqual(await durableCheckpoint(paths, manifest), baseCheckpoint);

    // A revoked policy permanently invalidates its existing scope. Exercise source
    // redaction in a second native accepted fixture with its own persistent profile.
    await worker.stop(); assert.notEqual(worker.diagnostics().exitCode, null); worker = undefined;
    purgeDirectory = await harness.createMarkedTempDirectory("eliotr-owner-e2e-artifact-purge-", purgeRunId, "artifact-state");
    purgePaths = await prepareArtifactProfile(purgeDirectory);
    await harness.applyOwnerE2EProfile(purgePaths, jwks.url);
    const purgeIssuedAt = Math.floor(Date.now() / 1000);
    const purgeIdentity = { principal_ref: "freeze-owner", credential_generation: "cf-access-jwt:" + OWNER_E2E_KID + ":" + purgeIssuedAt,
      deployment_generation: purgePaths.generation };
    const purgeToken = await harness.signOwnerToken(privateKey, { iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE],
      sub: purgeIdentity.principal_ref, type: "app", iat: purgeIssuedAt, exp: purgeIssuedAt + 3600 });
    process.stdout.write("owner-e2e artifact phase=second-native-accepted-snapshot\n");
    const purgeManifest = await prepareOwnerArtifactSnapshot(purgePaths, purgeIdentity);
    assert.notEqual(purgePaths.persist, paths.persist,
      "The purge case must use an independent persistent profile");
    await assertMigrationLedgers(purgePaths);
    const purgeArtifactPath = "/api/v1/research/artifact/" +
      encodeURIComponent(purgeManifest.artifact.id + ":" + purgeManifest.artifact.revision);
    const purgeBaseCheckpoint = await durableCheckpoint(purgePaths, purgeManifest);
    purgeWorker = await startLocalWorker(purgePaths);
    assert.ok(Number.isSafeInteger(purgeWorker.diagnostics().pid));
    await publicationRead(purgeWorker, purgeManifest, purgeArtifactPath, purgeToken, "artifact-purge-fixture-publication-read");
    const sourceRefs = purgeManifest.source_revision_refs;
    assert.equal(sourceRefs.length, 1, "The independent purge fixture must cite exactly one admitted source");
    const purgedRows = await fixtureMutation(purgePaths, "UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref=" +
      sqlText(sourceRefs[0]) + " AND purge_state='LIVE' RETURNING source_revision_ref");
    assert.deepEqual(purgedRows, [{ source_revision_ref: sourceRefs[0] }], "Redaction must return exactly the selected source revision");
    const purged = await harness.workerJson(purgeWorker.origin, purgeArtifactPath + "/publication",
      { token: purgeToken, worker: purgeWorker, phase: "artifact-purged-read" });
    assert.equal(purged.status, 404); assert.equal(purged.data.code, "ARTIFACT_DRAFT_READ_NOT_FOUND");
    receipt.source_purge = "PASS (real Worker refused accepted artifact after exact source-row redaction in an independent native fixture)";
    assert.deepEqual(await durableCheckpoint(purgePaths, purgeManifest), purgeBaseCheckpoint);
    await purgeWorker.stop(); assert.notEqual(purgeWorker.diagnostics().exitCode, null); purgeWorker = undefined;
    originalDirectory = await harness.createMarkedTempDirectory("eliotr-owner-e2e-artifact-original-", originalRunId, "artifact-state");
    paths = await prepareArtifactProfile(originalDirectory);
    await harness.applyOwnerE2EProfile(paths, jwks.url);
    const originalIssuedAt = Math.floor(Date.now() / 1000);
    const originalIdentity = { principal_ref: "freeze-owner", credential_generation: "cf-access-jwt:" + OWNER_E2E_KID + ":" + originalIssuedAt,
      deployment_generation: paths.generation };
    token = await harness.signOwnerToken(privateKey, { iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE],
      sub: originalIdentity.principal_ref, type: "app", iat: originalIssuedAt, exp: originalIssuedAt + 3600 });
    process.stdout.write("owner-e2e artifact phase=native-original-report-snapshot\n");
    manifest = await prepareOwnerArtifactSnapshot(paths, originalIdentity, "original-report");
    await assertMigrationLedgers(paths);
    artifactPath = "/api/v1/research/artifact/" + encodeURIComponent(manifest.artifact.id + ":" + manifest.artifact.revision);
    section = manifest.section;
    sectionPath = artifactPath + "/sections/" + encodeURIComponent(section.section_ref.id + ":" + section.section_ref.revision) + "/reauthorize";
    extras = [["GET", "/api/v1/system/session"], ["GET", "/api/v1/research/runs"],
      ["GET", "/api/v1/research/run/" + encodeURIComponent(manifest.run.operation_id)], ["GET", artifactPath], ["POST", artifactPath + "/reauthorize"],
      ["GET", artifactPath + "/publication"], ["GET", artifactPath + "/publication/current"], ["POST", sectionPath], ["POST", artifactPath + "/accept"]];
    const originalDraftCheckpoint = await durableCheckpoint(paths, manifest);
    await start(); await browserRead("original_before_restart"); await publicationRead();
    const originalAcceptedCheckpoint = await durableCheckpoint(paths, manifest);
    assert.deepEqual({ ...originalAcceptedCheckpoint, receipts: [] }, originalDraftCheckpoint,
      "PWA acceptance must preserve original model effects and every immutable R2 blob");
    process.stdout.write("owner-e2e artifact phase=true-original-report-worker-restart\n");
    const originalWorker = worker; await originalWorker.stop(); assert.notEqual(originalWorker.diagnostics().exitCode, null);
    worker = undefined; await start(); assert.notEqual(processIds.at(-2), processIds.at(-1));
    await browserRead("original_after_restart"); await publicationRead();
    assert.deepEqual(await durableCheckpoint(paths, manifest), originalAcceptedCheckpoint);
    receipt.run_reopen = "PASS (canonical original REPORT history/run status, PWA Accept/reopen and distinct Worker PID restart; exact Stage17 ref/receipt/section/blob readback and unchanged model effects)";
    return receipt;
  } finally {
    const failures = [];
    for (const close of [() => browser?.close(), () => bridge?.close(), () => purgeWorker?.stop(), () => worker?.stop(), () => jwks?.close(),
      () => originalDirectory === undefined ? undefined : removeHarnessOwned(originalDirectory, originalRunId),
      () => purgeDirectory === undefined ? undefined : removeHarnessOwned(purgeDirectory, purgeRunId),
      () => directory === undefined ? undefined : removeHarnessOwned(directory, runId), () => guard.release()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    assert.deepEqual(failures, [], "Every owned fixture/process/browser resource must be released");
  }
}
