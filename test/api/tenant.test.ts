import { describe, expect, it } from "vitest";

import { ServiceError } from "../../src/api/errors.js";
import { LOCAL_TENANT, parseTenant } from "../../src/api/tenant.js";

function refusal(raw: string | undefined): ServiceError {
  try {
    parseTenant(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    return error as ServiceError;
  }
  throw new Error(`parseTenant(${JSON.stringify(raw)}) did not throw`);
}

describe("parseTenant", () => {
  it.each(["local", "42", "org:7.a-b_c", "a".repeat(64)])("accepts %s", (raw) => {
    expect(parseTenant(raw)).toBe(raw);
  });

  it("LOCAL_TENANT is the backfill value", () => {
    expect(LOCAL_TENANT).toBe("local");
  });

  it.each([undefined, ""])("refuses %j as TENANT_REQUIRED", (raw) => {
    expect(refusal(raw).code).toBe("TENANT_REQUIRED");
  });

  it.each([" acme", ".", "..", "-x", "a/b", "a, b", "a".repeat(65), "é"])(
    "refuses %j as INVALID_TENANT without quoting it",
    (raw) => {
      const error = refusal(raw);
      expect(error.code).toBe("INVALID_TENANT");
      expect(error.message).not.toContain(raw);
    },
  );

  it("does not trim", () => {
    expect(refusal("acme ").code).toBe("INVALID_TENANT");
  });

  it("is case-sensitive: two spellings are two tenants", () => {
    expect(parseTenant("Acme")).not.toBe(parseTenant("acme"));
  });
});
