/**
 * TEST ONLY: a fixed credential key for every suite that constructs an
 * `ApiService`, `createApiServer`, `createMcpServer` or `createDemoServer`
 * (Phase 28b: `ServiceConfig.credentialKeys` is required).
 *
 * The bytes are a public constant in this repository, so anything encrypted
 * under them is readable by anyone who reads this file. Never use this key, or
 * its id, outside the test suite: a deployment sets its own
 * `ARIADNE_CREDENTIALS_KEY` from its secret store.
 */
import type { CredentialKey, CredentialKeys } from "../../src/crawl/credential-vault.js";

/** 32 fixed bytes, 0x00..0x1f. */
const TEST_KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

export const TEST_CREDENTIAL_KEY: CredentialKey = { id: "test-k1", key: TEST_KEY_BYTES };

export const TEST_CREDENTIAL_KEYS: CredentialKeys = { current: TEST_CREDENTIAL_KEY };

/** The same key as `ARIADNE_CREDENTIALS_KEY` spells it, for a spawned entrypoint. */
export const TEST_CREDENTIAL_KEY_ENV = `${TEST_CREDENTIAL_KEY.id}:${TEST_KEY_BYTES.toString("base64")}`;

/** Another key, for the suites that prove a row is unreadable under the wrong one. TEST ONLY. */
export function otherKey(id: string, fill: number): CredentialKey {
  return { id, key: Buffer.alloc(32, fill) };
}
