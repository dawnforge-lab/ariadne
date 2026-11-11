/**
 * The credential vault (Phase 28b item 10): a crawl's credential VALUES,
 * encrypted in `crawl_credentials`, so a resume after a deploy, a render on a
 * finished crawl, or a crawl picked up by another process runs without Talos
 * sending them again. It replaces the in-memory `CredentialStore` (27c/27d),
 * whose values a restart lost.
 *
 * THE CIPHER. AES-256-GCM from `node:crypto`, no dependency. Each write draws a
 * fresh random 12-byte nonce, and the 16-byte tag is appended to the
 * ciphertext. The associated data is `${crawlId}:${generation}`, where the
 * generation is `crawls.credential_generation`, which every write bumps in the
 * same transaction. So a ciphertext copied onto another crawl's row, or an
 * earlier write's ciphertext replayed onto this one, fails authentication.
 *
 * THE KEYS. `ARIADNE_CREDENTIALS_KEY` is `<id>:<base64 of 32 bytes>`, required
 * by every process that runs or accepts crawls; a missing or malformed key is a
 * boot error (`parseCredentialKeys`), never a mode that refuses credentials.
 * `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, same format and optional, only decrypts
 * rows written under its id; the next write re-encrypts under the current key.
 * The keys never reach the database: a row names its key by id.
 *
 * WHAT NEVER LEAVES MEMORY. A value is never logged, returned in an error,
 * thrown or stored in clear; nor is a key. Every message here names a
 * variable, a field or a crawl, never a value (the 27d no-key-echo discipline).
 *
 * WHEN A ROW CANNOT BE READ. `read` answers `unreadable` with the reason — its
 * key id is neither key's (`unknown-key`) or the tag does not authenticate
 * (`auth-failed`) — and never throws for either: the caller decides. The
 * service answers 409 `CREDENTIALS_REQUIRED` on a resume or a render, and the
 * runner pauses the crawl `credentials_unreadable`. A row that authenticates
 * and then does not parse as credentials is OUR defect and throws (rule 7).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawlCredentials, crawls } from "../db/schema.js";
import type { TenantId } from "../tenant.js";
import { credentialError, shapeOf, type CrawlCredentials } from "./credentials.js";

export const CREDENTIALS_KEY_VAR = "ARIADNE_CREDENTIALS_KEY";
export const CREDENTIALS_KEY_PREVIOUS_VAR = "ARIADNE_CREDENTIALS_KEY_PREVIOUS";
export const CREDENTIALS_RETENTION_VAR = "ARIADNE_CREDENTIALS_RETENTION_DAYS";

/** How long a settled crawl's credentials are kept, unless the operator says otherwise. */
export const DEFAULT_CREDENTIAL_RETENTION_DAYS = 30;

/** AES-256: the key is exactly this many bytes. */
export const CREDENTIAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

/** A key id: what a row stores to say which key wrote it. Never a secret, never quoted all the same. */
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Standard base64, padded. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type CredentialKey = { id: string; key: Buffer };
export type CredentialKeys = { current: CredentialKey; previous?: CredentialKey };

export type CredentialRead =
  | { kind: "none" }
  | { kind: "ok"; credentials: CrawlCredentials; generation: number }
  | { kind: "unreadable"; reason: "unknown-key" | "auth-failed" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The database or a transaction on it: what a statement can run on. */
type Executor = Db | Tx;

/**
 * The credential keys from the environment, or a boot error naming the
 * variable and what is wrong with it — never the value, nor any part of it.
 *
 * `ARIADNE_CREDENTIALS_KEY` is required. `ARIADNE_CREDENTIALS_KEY_PREVIOUS`
 * is optional: unset or empty means there is no previous key (a deploy that
 * templates an unset variable as `""` is saying the same thing), and anything
 * else must be a well-formed key with an id other than the current one's —
 * one id naming two keys would leave a row's key ambiguous.
 */
export function parseCredentialKeys(env: NodeJS.ProcessEnv): CredentialKeys {
  const raw = env[CREDENTIALS_KEY_VAR];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${CREDENTIALS_KEY_VAR} must be set to '<id>:<base64 of ${CREDENTIAL_KEY_BYTES} bytes>': ` +
        "every process that accepts or runs crawls encrypts their credentials with it, and there is no default",
    );
  }
  const current = parseKey(CREDENTIALS_KEY_VAR, raw);
  const previousRaw = env[CREDENTIALS_KEY_PREVIOUS_VAR];
  if (previousRaw === undefined || previousRaw.trim() === "") return { current };
  const previous = parseKey(CREDENTIALS_KEY_PREVIOUS_VAR, previousRaw);
  if (previous.id === current.id) {
    throw new Error(
      `${CREDENTIALS_KEY_PREVIOUS_VAR} has the same id as ${CREDENTIALS_KEY_VAR}: a rotation ` +
        "gives the new key a new id, so a row says which of the two wrote it",
    );
  }
  return { current, previous };
}

/** One `<id>:<base64>` key. Every refusal names `variable` and the rule, never the value. */
function parseKey(variable: string, raw: string): CredentialKey {
  const value = raw.trim();
  const colon = value.indexOf(":");
  if (colon < 0) {
    throw new Error(
      `${variable} must be '<id>:<base64 of ${CREDENTIAL_KEY_BYTES} bytes>', and it has no ':' ` +
        "separating the id from the key",
    );
  }
  const id = value.slice(0, colon);
  const encoded = value.slice(colon + 1);
  if (!KEY_ID_PATTERN.test(id)) {
    throw new Error(
      `${variable}'s id (before the ':') must be 1 to 64 letters, digits, '.', '_' or '-'`,
    );
  }
  if (encoded === "" || !BASE64_PATTERN.test(encoded)) {
    throw new Error(`${variable}'s key (after the ':') is not standard padded base64`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `${variable}'s key decodes to ${key.length} bytes; AES-256 needs exactly ${CREDENTIAL_KEY_BYTES}`,
    );
  }
  return { id, key };
}

/**
 * `ARIADNE_CREDENTIALS_RETENTION_DAYS`: the days a settled crawl keeps its
 * credentials. Unset or empty is the default, 30; anything else must be a
 * positive integer, refused at boot by name otherwise.
 */
export function parseCredentialRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = (env[CREDENTIALS_RETENTION_VAR] ?? "").trim();
  if (raw === "") return DEFAULT_CREDENTIAL_RETENTION_DAYS;
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error(`${CREDENTIALS_RETENTION_VAR} must be a positive whole number of days`);
  }
  return Number(raw);
}

/** The same rule for a retention passed in code (`ServiceConfig.credentialRetentionDays`). */
export function assertRetentionDays(days: number, field: string): void {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(`${field} must be a positive whole number of days`);
  }
}

function assertKey(key: CredentialKey, field: string): void {
  if (!KEY_ID_PATTERN.test(key.id)) {
    throw new Error(`${field}.id must be 1 to 64 letters, digits, '.', '_' or '-'`);
  }
  if (!Buffer.isBuffer(key.key) || key.key.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(`${field}.key must be a Buffer of exactly ${CREDENTIAL_KEY_BYTES} bytes`);
  }
}

function associatedData(crawlId: string, generation: number): Buffer {
  return Buffer.from(`${crawlId}:${generation}`, "utf8");
}

/**
 * Only the three credential fields, in a fixed order: what is encrypted is
 * exactly what `CrawlCredentials` says, whatever else an object carried.
 */
function canonical(c: CrawlCredentials): CrawlCredentials {
  return {
    ...(c.requestHeaders === undefined ? {} : { requestHeaders: { ...c.requestHeaders } }),
    ...(c.httpAuth === undefined
      ? {}
      : { httpAuth: { username: c.httpAuth.username, password: c.httpAuth.password } }),
    ...(c.cookies === undefined
      ? {}
      : { cookies: c.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value })) }),
  };
}

export class CredentialVault {
  private readonly keys: CredentialKeys;

  constructor(
    private readonly db: Db,
    keys: CredentialKeys,
  ) {
    assertKey(keys.current, "credentialKeys.current");
    if (keys.previous !== undefined) {
      assertKey(keys.previous, "credentialKeys.previous");
      if (keys.previous.id === keys.current.id) {
        throw new Error("credentialKeys.previous has the same id as credentialKeys.current");
      }
    }
    this.keys = keys;
  }

  /**
   * Encrypt `creds` under the current key and write them as the crawl's row,
   * inside the caller's transaction (`tx`), replacing any row it had. Bumps
   * `crawls.credential_generation` first — which also takes the crawl row's
   * lock, so concurrent writers queue on the crawl in one order — and answers
   * the new generation.
   *
   * Throws when no crawl `crawlId` belongs to `tenant`, and on credentials
   * that are empty or malformed: the callers validate what a request sends, so
   * either is our defect, named by field and never by value.
   */
  async write(tx: Tx, tenant: TenantId, crawlId: string, creds: CrawlCredentials): Promise<number> {
    const values = canonical(creds);
    if (shapeOf(values) === null) {
      throw new Error(`credential vault: crawl ${crawlId}: there are no credentials to write`);
    }
    const invalid = credentialError(values, "credentials");
    if (invalid !== null) {
      throw new Error(`credential vault: crawl ${crawlId}: refusing to write invalid credentials: ${invalid}`);
    }
    const bumped = await tx
      .update(crawls)
      .set({ credentialGeneration: sql`${crawls.credentialGeneration} + 1` })
      .where(and(eq(crawls.id, crawlId), eq(crawls.tenantId, tenant)))
      .returning({ generation: crawls.credentialGeneration });
    const generation = bumped[0]?.generation;
    if (generation === undefined) {
      throw new Error(`credential vault: no crawl ${crawlId} of this tenant to write credentials for`);
    }
    const { id: keyId, key } = this.keys.current;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(crawlId, generation));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(values), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const now = new Date();
    await tx
      .insert(crawlCredentials)
      .values({ crawlId, tenantId: tenant, generation, keyId, nonce, ciphertext, updatedAt: now })
      .onConflictDoUpdate({
        target: crawlCredentials.crawlId,
        set: { tenantId: tenant, generation, keyId, nonce, ciphertext, updatedAt: now },
      });
    return generation;
  }

  /**
   * The crawl's credentials, decrypted: `none` when it has no row, `ok` with
   * the values and the generation they were written at, or `unreadable` with
   * the reason. The generation used as associated data is the CRAWL's
   * (`crawls.credential_generation`), so a whole row replayed from an earlier
   * write — its generation column included — does not authenticate either.
   *
   * `executor` lets a caller read inside its own transaction (the snapshot a
   * runner takes, the locked row `crawl_config_set` merges onto); it defaults
   * to the database.
   */
  async read(crawlId: string, executor: Executor = this.db): Promise<CredentialRead> {
    const rows = await executor
      .select({
        generation: crawlCredentials.generation,
        keyId: crawlCredentials.keyId,
        nonce: crawlCredentials.nonce,
        ciphertext: crawlCredentials.ciphertext,
        crawlGeneration: crawls.credentialGeneration,
      })
      .from(crawlCredentials)
      .innerJoin(crawls, eq(crawls.id, crawlCredentials.crawlId))
      .where(eq(crawlCredentials.crawlId, crawlId));
    const row = rows[0];
    if (row === undefined) return { kind: "none" };

    const key =
      row.keyId === this.keys.current.id
        ? this.keys.current.key
        : row.keyId === this.keys.previous?.id
          ? this.keys.previous.key
          : null;
    if (key === null) return { kind: "unreadable", reason: "unknown-key" };

    // A row from another generation than the crawl's is a replay: the write
    // that bumped the crawl's counter wrote its own row beside it.
    if (row.generation !== row.crawlGeneration) return { kind: "unreadable", reason: "auth-failed" };
    if (row.nonce.length !== NONCE_BYTES || row.ciphertext.length < TAG_BYTES) {
      return { kind: "unreadable", reason: "auth-failed" };
    }
    const body = row.ciphertext.subarray(0, row.ciphertext.length - TAG_BYTES);
    const tag = row.ciphertext.subarray(row.ciphertext.length - TAG_BYTES);
    let plaintext: string;
    try {
      const decipher = createDecipheriv(CIPHER, key, row.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(crawlId, row.crawlGeneration));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      // The nonce and the tag are of the lengths GCM takes and the key is 32
      // bytes, all checked above, so what `final` refuses here is the tag:
      // the row was not written by this key for this crawl and generation.
      return { kind: "unreadable", reason: "auth-failed" };
    }

    // Authenticated, so written by us: a body that does not parse as the
    // credentials we encrypted is our defect, and loud. The messages carry no
    // value — `credentialError` names fields and positions only.
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error(`credential vault: crawl ${crawlId}'s decrypted credentials are not JSON`);
    }
    const invalid = credentialError(parsed, "credentials");
    if (invalid !== null) {
      throw new Error(`credential vault: crawl ${crawlId}'s decrypted credentials are invalid: ${invalid}`);
    }
    const credentials = parsed as CrawlCredentials;
    if (shapeOf(credentials) === null) {
      throw new Error(`credential vault: crawl ${crawlId}'s stored credentials are empty`);
    }
    return { kind: "ok", credentials, generation: row.crawlGeneration };
  }

  /** Delete the crawl's row, if it has one, on the database or inside the caller's transaction. */
  async remove(executor: Executor, crawlId: string): Promise<void> {
    await executor.delete(crawlCredentials).where(eq(crawlCredentials.crawlId, crawlId));
  }

  /**
   * Delete the credentials of every crawl that settled — any status but
   * `queued`, `running` and `paused` — more than `retentionDays` before `now`,
   * by its `finished_at`, and answer how many rows went. A paused crawl keeps
   * them however long it waits: it is resumable, and a resume needs them.
   * Talos can send them again after the sweep.
   */
  async sweepExpired(now: Date, retentionDays: number): Promise<number> {
    assertRetentionDays(retentionDays, "retentionDays");
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const expired = this.db
      .select({ id: crawls.id })
      .from(crawls)
      .where(
        and(
          notInArray(crawls.status, ["queued", "running", "paused"]),
          lt(crawls.finishedAt, cutoff),
        ),
      );
    const result = await this.db
      .delete(crawlCredentials)
      .where(inArray(crawlCredentials.crawlId, expired));
    if (result.rowCount === null) {
      throw new Error("credential vault: the retention sweep's delete reported no row count");
    }
    return result.rowCount;
  }
}
