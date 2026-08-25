import { describe, expect, it } from "vitest";
import { ARIADNE } from "../src/index.js";

describe("scaffold", () => {
  it("compiles and imports", () => {
    expect(ARIADNE).toBe("ariadne");
  });
});
