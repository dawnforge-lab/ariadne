import { describe, expect, it } from "vitest";
import { SCHEMA_ORG_CONTEXT, schemaOrgName } from "../../src/crawl/parse/schema-names.js";

describe("schemaOrgName", () => {
  it("reduces every spelling of a schema.org term to the bare name", () => {
    expect(schemaOrgName("Product")).toBe("Product");
    expect(schemaOrgName(" schema:Product ")).toBe("Product");
    expect(schemaOrgName("https://schema.org/Product")).toBe("Product");
    expect(schemaOrgName("http://www.schema.org/Product")).toBe("Product");
  });
  it("returns null for anything that is not a schema.org term", () => {
    expect(schemaOrgName("https://example.org/Thing")).toBeNull();
    expect(schemaOrgName("og:title")).toBeNull();
    expect(schemaOrgName("")).toBeNull();
    expect(schemaOrgName("https://schema.org/")).toBeNull();
    expect(schemaOrgName("schema:")).toBeNull();
  });
  it("exports the context URL", () => {
    expect(SCHEMA_ORG_CONTEXT).toBe("https://schema.org");
  });
});
