/**
 * Phase 28c Task 3: a schedule's cron and timezone (`parseCron`) and its next
 * slot (`nextSlot`, src/schedule/cron.ts).
 *
 * Pure: no database. The two daylight-saving dates are Review Focus 2's
 * (`30 1 * * *` in Europe/London on 2026-03-29, when 01:30 does not exist, and
 * on 2026-10-25, when it happens twice): each day gives one slot, and every
 * slot is strictly after the instant it was asked from. February 30th is
 * Review Focus 1's cron that never matches.
 */
import { describe, expect, it } from "vitest";

import { CRON_HORIZON_DAYS, NoCronSlotError, nextSlot, parseCron } from "../../src/schedule/cron.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-12T12:00:00.000Z");

describe("parseCron: the expression", () => {
  it("accepts five fields, however they are spaced", () => {
    expect(parseCron("30 1 * * *", "Europe/London", NOW)).toEqual({ ok: true });
    expect(parseCron("  */15  9-17 * * mon-fri ", "UTC", NOW)).toEqual({ ok: true });
    expect(parseCron("0 3 * * 1", "America/New_York", NOW)).toEqual({ ok: true });
  });

  it("refuses four fields and six (seconds), naming cron", () => {
    for (const cron of ["30 1 * *", "0 30 1 * * *", "", "   ", "@daily"]) {
      const answer = parseCron(cron, "UTC", NOW);
      expect(answer.ok, JSON.stringify(cron)).toBe(false);
      if (answer.ok) continue;
      expect(answer.field).toBe("cron");
      expect(answer.message).toMatch(/exactly five whitespace-separated fields/);
    }
  });

  it("refuses a field out of range, naming cron", () => {
    const answer = parseCron("60 1 * * *", "UTC", NOW);
    expect(answer).toMatchObject({ ok: false, field: "cron" });
  });

  it("refuses a hashed field (H): its minute is random per parse, so no slot is fixed", () => {
    const answer = parseCron("H 1 * * *", "UTC", NOW);
    expect(answer).toMatchObject({ ok: false, field: "cron" });
    if (!answer.ok) expect(answer.message).toMatch(/'H'/);
  });

  it("refuses February 30th (Review Focus 1), naming cron", () => {
    const answer = parseCron("0 0 30 2 *", "UTC", NOW);
    expect(answer).toMatchObject({ ok: false, field: "cron" });
  });

  it("refuses an expression whose first slot is more than 366 days away, and accepts it when it is not", () => {
    // February 29th: from 2026-11-12 the next is 2028-02-29, 474 days on.
    const far = parseCron("0 0 29 2 *", "UTC", NOW);
    expect(far).toMatchObject({ ok: false, field: "cron" });
    if (!far.ok) expect(far.message).toMatch(/no slot in the next 366 days/);
    // From 2027-03-01 it is 365 days on.
    expect(parseCron("0 0 29 2 *", "UTC", new Date("2027-03-01T00:00:00Z"))).toEqual({ ok: true });
  });

  it("refuses a day that no named month has (31 April or June), naming cron", () => {
    expect(parseCron("0 0 31 4,6 *", "UTC", NOW)).toMatchObject({ ok: false, field: "cron" });
  });
});

describe("parseCron: the timezone", () => {
  it("refuses Europe/Londn, naming timezone", () => {
    const answer = parseCron("30 1 * * *", "Europe/Londn", NOW);
    expect(answer).toMatchObject({ ok: false, field: "timezone" });
    if (!answer.ok) expect(answer.message).toMatch(/IANA/);
  });

  it("refuses an empty timezone, naming timezone", () => {
    expect(parseCron("30 1 * * *", "", NOW)).toMatchObject({ ok: false, field: "timezone" });
  });

  it("accepts UTC and an IANA zone", () => {
    expect(parseCron("0 0 * * *", "UTC", NOW)).toEqual({ ok: true });
    expect(parseCron("0 0 * * *", "Asia/Kolkata", NOW)).toEqual({ ok: true });
  });
});

describe("nextSlot", () => {
  it("is strictly after `after`, also when `after` is itself a slot", () => {
    const slot = new Date("2026-11-13T03:00:00.000Z");
    expect(nextSlot("0 3 * * *", "UTC", new Date("2026-11-12T12:00:00Z"))).toEqual(slot);
    expect(nextSlot("0 3 * * *", "UTC", slot)).toEqual(new Date("2026-11-14T03:00:00.000Z"));
    // A millisecond past a slot is past it.
    expect(nextSlot("0 3 * * *", "UTC", new Date(slot.getTime() + 1))).toEqual(
      new Date("2026-11-14T03:00:00.000Z"),
    );
    // A millisecond before it is not.
    expect(nextSlot("0 3 * * *", "UTC", new Date(slot.getTime() - 1))).toEqual(slot);
  });

  it("computes the slot in the schedule's zone", () => {
    // NOW is 07:00 in New York (EST, UTC-5): 09:00 there is 14:00 UTC the same day, and 06:00 is tomorrow's.
    expect(nextSlot("0 9 * * *", "America/New_York", NOW)).toEqual(new Date("2026-11-12T14:00:00.000Z"));
    expect(nextSlot("0 6 * * *", "America/New_York", NOW)).toEqual(new Date("2026-11-13T11:00:00.000Z"));
  });

  it("throws for February 30th: there is no slot within 366 days (Review Focus 1)", () => {
    expect(() => nextSlot("0 0 30 2 *", "UTC", NOW)).toThrow(NoCronSlotError);
    expect(() => nextSlot("0 0 31 4,6 *", "UTC", NOW)).toThrow(NoCronSlotError);
  });

  it(`throws when the first slot is more than ${CRON_HORIZON_DAYS} days after \`after\``, () => {
    expect(() => nextSlot("0 0 29 2 *", "UTC", NOW)).toThrow(NoCronSlotError);
    expect(() => nextSlot("0 0 29 2 *", "UTC", NOW)).toThrow(/no slot in the next 366 days/);
    const from = new Date("2027-03-01T00:00:00Z");
    const leap = nextSlot("0 0 29 2 *", "UTC", from);
    expect(leap).toEqual(new Date("2028-02-29T00:00:00.000Z"));
    expect(leap.getTime() - from.getTime()).toBeLessThanOrEqual(CRON_HORIZON_DAYS * DAY_MS);
  });

  it("throws on an expression or a zone parseCron refuses: its caller validated them", () => {
    expect(() => nextSlot("0 0 * *", "UTC", NOW)).toThrow(/exactly five/);
    expect(() => nextSlot("0 0 * * *", "Europe/Londn", NOW)).toThrow(/timezone/);
    expect(() => nextSlot("0 0 * * *", "UTC", new Date(Number.NaN))).toThrow(/not a valid instant/);
  });
});

describe("nextSlot across daylight saving (Review Focus 2): 30 1 * * * in Europe/London", () => {
  /** Every slot from `from` until `until`, each asked strictly after the last. */
  function slotsBetween(from: Date, until: Date): Date[] {
    const out: Date[] = [];
    let after = from;
    for (;;) {
      const slot = nextSlot("30 1 * * *", "Europe/London", after);
      expect(slot.getTime()).toBeGreaterThan(after.getTime());
      if (slot >= until) return out;
      out.push(slot);
      after = slot;
    }
  }

  /** The London calendar date of an instant. */
  function londonDay(d: Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
  }

  it("2026-03-29 (01:30 does not exist): one slot that day, one each day either side", () => {
    const slots = slotsBetween(new Date("2026-03-27T12:00:00Z"), new Date("2026-03-31T12:00:00Z"));
    expect(slots.map(londonDay)).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
    // 01:30 GMT the day before; the skipped hour's slot lands at 02:30 BST (01:30 UTC); then 01:30 BST.
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
  });

  it("2026-10-25 (01:30 happens twice): one slot that day, not two", () => {
    const slots = slotsBetween(new Date("2026-10-23T12:00:00Z"), new Date("2026-10-27T12:00:00Z"));
    expect(slots.map(londonDay)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ]);
  });

  it("asked from the first 01:30 of 2026-10-25 (a fire's own instant), the next slot is the next day's", () => {
    // 00:30 UTC is the first 01:30 (BST); 01:30 UTC would be the second (GMT).
    expect(nextSlot("30 1 * * *", "Europe/London", new Date("2026-10-25T00:30:00.000Z"))).toEqual(
      new Date("2026-10-26T01:30:00.000Z"),
    );
    // A fire a few seconds late computes from its own `now`, and still skips the repeat.
    expect(nextSlot("30 1 * * *", "Europe/London", new Date("2026-10-25T00:30:07.250Z"))).toEqual(
      new Date("2026-10-26T01:30:00.000Z"),
    );
  });
});
