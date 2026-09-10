import { describe, expect, it } from "vitest";
import { REQUIRED_GOOGLE_SCOPES, scopesAreNarrowAndComplete } from "./token-vault.js";

describe("dedicated Drive scopes", () => {
  it("rejects every additional privilege, not only full Drive", () => {
    for (const extra of ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/cloud-platform", "profile", "https://www.googleapis.com/auth/drive.readonly"]) {
      expect(scopesAreNarrowAndComplete([...REQUIRED_GOOGLE_SCOPES, extra])).toBe(false);
    }
  });
});

import { createAesGcmTokenVault, importGoogleTokenKey, type GoogleTokenBinding } from "./token-vault.js";
const binding: GoogleTokenBinding = { connection_id: "connection-1", principal_id: "owner-1", oauth_client_id: "client.apps.googleusercontent.com",
  google_subject: "1234567", google_email: "exchange@example.com", credential_generation: "grant-1" };
const key = () => importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)));
it("accepts only complete, unique scope spellings including Google's email alias", () => {
  expect(scopesAreNarrowAndComplete([...REQUIRED_GOOGLE_SCOPES])).toBe(true);
  expect(scopesAreNarrowAndComplete(["openid", "https://www.googleapis.com/auth/userinfo.email", REQUIRED_GOOGLE_SCOPES[2]])).toBe(true);
  const sparse = new Array<string>(3); sparse[0] = "openid"; sparse[2] = REQUIRED_GOOGLE_SCOPES[2];
  for (const scopes of [[], ["openid", "email"], [...REQUIRED_GOOGLE_SCOPES, "email"], sparse, null, "openid email"]) {
    expect(scopesAreNarrowAndComplete(scopes as string[])).toBe(false);
  }
});
describe("AES-GCM refresh-token vault", () => {
  it("roundtrips opaque tokens with fresh 96-bit nonces and nonextractable 256-bit keys", async () => {
    const kek = await key(); const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, kek]]) });
    const a = await vault.encrypt("secret-refresh+/=token"); const b = await vault.encrypt("secret-refresh+/=token");
    expect(a.nonce.length).toBe(12); expect(a.nonce).not.toEqual(b.nonce); expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.ciphertext.length).toBe("secret-refresh+/=token".length + 16);
    expect(await vault.decrypt(a)).toBe("secret-refresh+/=token");
    await expect(crypto.subtle.exportKey("raw", kek)).rejects.toThrow();
  });
  it("rejects swapping a ciphertext across every identity/context axis", async () => {
    const keys = new Map([[1, await key()]]); const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys });
    const token = await vault.encrypt("refresh-secret");
    for (const field of Object.keys(binding) as (keyof GoogleTokenBinding)[]) {
      const other = createAesGcmTokenVault({ binding: { ...binding, [field]: field === "google_email" ? "other@example.com" : "other" }, activeKeyVersion: 1, keys });
      await expect(other.decrypt(token)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_DECRYPT_FAILED" });
    }
  });
  it("detects altered tag, ciphertext, nonce and key-version even with aliased key material", async () => {
    const kek = await key(); const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 2, keys: new Map([[1, kek], [2, kek]]) });
    const token = await vault.encrypt("refresh-secret");
    for (const field of ["ciphertext", "nonce"] as const) {
      const changed = { ...token, [field]: new Uint8Array(token[field]) }; changed[field][0] = (changed[field][0] ?? 0) ^ 1;
      await expect(vault.decrypt(changed)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_DECRYPT_FAILED" });
    }
    await expect(vault.decrypt({ ...token, key_version: 1 })).rejects.toMatchObject({ code: "GOOGLE_TOKEN_DECRYPT_FAILED" });
  });
  it("rotates to the active KEK without changing plaintext or permitting key downgrade", async () => {
    const old = await key(); const fresh = await key();
    const initial = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, old]]) });
    const rotating = createAesGcmTokenVault({ binding, activeKeyVersion: 2, keys: new Map([[1, old], [2, fresh]]) });
    const original = await initial.encrypt("refresh-secret"); const rotated = await rotating.rotate(original);
    expect(rotated.key_version).toBe(2); expect(await rotating.decrypt(rotated)).toBe("refresh-secret");
    expect(await initial.decrypt(original)).toBe("refresh-secret");
    const retired = createAesGcmTokenVault({ binding, activeKeyVersion: 2, keys: new Map([[2, fresh]]) });
    await expect(retired.decrypt(original)).rejects.toMatchObject({ code: "GOOGLE_TOKEN_KEY_UNAVAILABLE" });
    expect(() => createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, old], [2, fresh]]) })).toThrow();
  });
  it("snapshots keys, binding and bytes across asynchronous crypto calls", async () => {
    const input = { ...binding }; const keys = new Map([[1, await key()]]);
    const vault = createAesGcmTokenVault({ binding: input, activeKeyVersion: 1, keys });
    input.connection_id = "changed"; keys.clear();
    const record = await vault.encrypt("refresh-secret"); const pending = vault.decrypt(record);
    record.ciphertext.fill(0); record.nonce.fill(0); expect(await pending).toBe("refresh-secret");
  });
  it("rejects plaintext/record overflow, unknown fields, invalid UTF-8 and malformed tokens", async () => {
    const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, await key()]]) });
    expect(await vault.decrypt(await vault.encrypt("x".repeat(4096)))).toHaveLength(4096);
    for (const token of ["", "x".repeat(4097), "with space", "with\nnewline", "\ud800", "Я", null]) await expect(vault.encrypt(token as string)).rejects.toThrow();
    const token = await vault.encrypt("refresh-secret");
    for (const patch of [{ key_version: 0 }, { key_version: 1.1 }, { key_version: Infinity }, { nonce: new Uint8Array(13) },
      { ciphertext: new Uint8Array(16) }, { ciphertext: new Uint8Array(4113) }, { plaintext: "refresh-secret" }]) {
      await expect(vault.decrypt({ ...token, ...patch })).rejects.toThrow();
    }
  });
  it("rejects weak/extractable/wrong-usage/unknown keys and oversized or incomplete bindings", async () => {
    await expect(importGoogleTokenKey(new Uint8Array(31))).rejects.toThrow();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    for (const kek of [await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]),
      await crypto.subtle.importKey("raw", raw.slice(0, 16), "AES-GCM", false, ["encrypt", "decrypt"]),
      await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"])]) {
      expect(() => createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, kek]]) })).toThrow();
    }
    const keys = new Map([[1, await key()]]);
    expect(() => createAesGcmTokenVault({ binding, activeKeyVersion: 2, keys })).toThrow();
    for (const patch of [{ google_subject: "" }, { principal_id: "x".repeat(257) }, { google_email: "bad" }, { extra: true }]) {
      expect(() => createAesGcmTokenVault({ binding: { ...binding, ...patch }, activeKeyVersion: 1, keys })).toThrow();
    }
  });
  it("never includes plaintext, key material or underlying diagnostics in failures", async () => {
    const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys: new Map([[1, await key()]]) });
    const encrypted = await vault.encrypt("secret-refresh"); encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1;
    try { await vault.decrypt(encrypted); expect.fail("must reject"); } catch (error) {
      expect(String(error)).toBe("GoogleCredentialError: GOOGLE_TOKEN_DECRYPT_FAILED");
      expect(JSON.stringify(error)).not.toContain("secret-refresh");
    }
  });
});
