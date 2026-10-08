import assert from "node:assert/strict";
import process from "node:process";
import ts from "typescript";
import {
  createPrepareDeclarationMetadata,
  prepareDeclarationKindAt,
  prepareDeclarationMetadataKey,
  PREPARE_DECLARATION_KIND,
} from "./prepare-declaration-provenance.mjs";

const file = "C:/fixture/prepare-declaration-provenance.ts";
const source = ts.createSourceFile(file, `
database.prepare("SELECT 1 FROM database");
session.prepare("SELECT 1 FROM inherited_session");
sessionOwn.prepare("SELECT 1 FROM session");
foreign.prepare("SELECT 1 FROM foreign");
missing.prepare("SELECT 1 FROM unresolved");
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const calls = [];
function collect(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "prepare") calls.push(node);
  ts.forEachChild(node, collect);
}
collect(source);

const databasePrepare = {};
const sessionPrepare = {};
const foreignPrepare = {};
const signatures = new Map([
  [calls[0], { declaration: databasePrepare }],
  [calls[1], { declaration: databasePrepare }],
  [calls[2], { declaration: sessionPrepare }],
  [calls[3], { declaration: foreignPrepare }],
]);
const receiverKinds = new Map([
  ["database", PREPARE_DECLARATION_KIND.database],
  ["session", PREPARE_DECLARATION_KIND.session],
  ["sessionOwn", PREPARE_DECLARATION_KIND.session],
]);
const checker = {
  getResolvedSignature(call) { return signatures.get(call); },
  getTypeAtLocation(receiver) { return receiver.text; },
};
const canonicalAuthority = {
  prepareDeclarationKinds: new Map([
    [databasePrepare, PREPARE_DECLARATION_KIND.database],
    [sessionPrepare, PREPARE_DECLARATION_KIND.session],
  ]),
  receiverKind(type) { return receiverKinds.get(type); },
};
const program = { getSourceFiles: () => [source] };
const metadata = createPrepareDeclarationMetadata({
  program,
  checker,
  sourceFiles: [source],
  canonicalAuthority,
});

assert.deepEqual(calls.map((call) => prepareDeclarationKindAt(metadata, file, call.getStart(source))), [
  PREPARE_DECLARATION_KIND.database,
  PREPARE_DECLARATION_KIND.session,
  PREPARE_DECLARATION_KIND.session,
  PREPARE_DECLARATION_KIND.nonCanonical,
  PREPARE_DECLARATION_KIND.unresolved,
]);
assert.equal(metadata.size, calls.length, "each source prepare site receives one bounded enum classification");
assert.equal(prepareDeclarationKindAt(undefined, file, calls[0].getStart(source)), PREPARE_DECLARATION_KIND.noSharedProgram);
assert.equal(prepareDeclarationMetadataKey(file, calls[0].getStart(source)).includes("SELECT"), false);
assert.deepEqual([...metadata.values()].filter((value) => !Object.values(PREPARE_DECLARATION_KIND).includes(value)), []);
assert.equal(createPrepareDeclarationMetadata({ checker, sourceFiles: [source], canonicalAuthority }).size, 0,
  "metadata construction never creates or guesses a missing shared Program");

process.stdout.write("D1 prepare declaration metadata fixtures passed\n");
