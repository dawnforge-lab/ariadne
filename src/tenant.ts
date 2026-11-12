/**
 * The tenant key (Phase 28a). A tenant is the owner of a crawl: every crawl row
 * carries one, and the API scopes every read and write by it.
 *
 * `TenantId` is a branded string so a raw string cannot reach `runCrawl` or a
 * crawl insert unchecked; the only constructors are `parseTenant` and the
 * `LOCAL_TENANT` constant.
 */
import { dirname, resolve as resolvePath } from "node:path";

import { ServiceError } from "./api/errors.js";

export type TenantId = string & { readonly __tenant: unique symbol };

/** Case-sensitive: `Acme` and `acme` are two tenants. */
export const TENANT_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Validate a tenant key. Does not trim: whitespace fails the pattern. Messages
 * never quote the value sent.
 */
export function parseTenant(raw: string | undefined): TenantId {
  if (raw === undefined || raw === "") {
    throw new ServiceError("TENANT_REQUIRED", "a tenant is required");
  }
  if (!TENANT_PATTERN.test(raw)) {
    throw new ServiceError(
      "INVALID_TENANT",
      "tenant must be 1 to 64 characters of letters and digits plus dot, underscore, colon and hyphen, " +
        "starting with a letter or digit",
    );
  }
  return raw as TenantId;
}

/** The backfill value (migration 0037); used by scripts and tests. */
export const LOCAL_TENANT: TenantId = parseTenant("local");

/**
 * Where a tenant's export files live: `<exportDir>/<tenant>/`, absolute. The
 * writer (`ApiService.exportCrawl`) and the remover (`deleteCrawlFiles`) both
 * ask here, so the two cannot disagree about where a tenant's files are.
 *
 * Throws if the directory would not be a direct child of `exportDir` — which a
 * `parseTenant` value cannot produce (no separator; never `.` or `..`), and
 * which a containment check that only looked at the file would not catch.
 */
export function tenantExportDir(exportDir: string, tenant: TenantId): string {
  const base = resolvePath(exportDir);
  const dir = resolvePath(base, tenant);
  if (dirname(dir) !== base) {
    throw new Error("export: a tenant's export directory must be a direct child of the export directory");
  }
  return dir;
}
