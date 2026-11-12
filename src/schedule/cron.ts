/**
 * A schedule's cron and timezone (Phase 28c): `parseCron` checks them at
 * create and update, and `nextSlot` computes the instant a schedule fires next.
 *
 * THE EXPRESSION is standard five-field cron — minute, hour, day of month,
 * month, day of week — separated by whitespace. A sixth (seconds) field is
 * refused, and so is any one-word alias (`@daily`): exactly five fields, so a
 * schedule reads the same in every cron a person knows. The slots are computed
 * by `cron-parser` (MIT) in the schedule's own zone. One of its extensions is
 * refused: `H`, a hashed value, which without a seed is drawn at random on
 * every parse — the slot computed at create would not be the slot computed at
 * fire.
 *
 * THE TIMEZONE is an IANA name: one `Intl.supportedValuesOf("timeZone")`
 * lists, or `UTC`, or an `Area/Location` name the runtime resolves to one it
 * lists — the same zone database `cron-parser` (through luxon) computes in.
 * An offset (`+05:00`) or an abbreviation (`EST`) is refused.
 *
 * THE HORIZON. An expression with no slot in the next 366 days is refused
 * (Review Focus 1: February 30th never matches, and a scheduler must not loop
 * looking for it). 366 days is one slot a year in any year, a leap day's
 * excepted: `0 0 29 2 *` is accepted only within a year of the 29th.
 *
 * DAYLIGHT SAVING (Review Focus 2). Each slot is strictly after the instant it
 * was asked from, and a wall-clock time that a change skips or repeats gives
 * one slot that day: `30 1 * * *` in Europe/London fires at 02:30 BST on the
 * spring day (01:30 does not exist) and at the first 01:30 on the autumn day.
 */
import { CronExpressionParser } from "cron-parser";

/**
 * `cron-parser`'s two "no slot" messages, as 5.x throws them from `next()`. Its
 * `CronExpression` module declares them as constants but the package root does
 * not export them, so they are restated here; test/schedule/cron.test.ts drives
 * both (February 29th past the horizon, 31 April or June), so a release that
 * rewords one fails there rather than turning a refusal into a defect.
 */
const TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE = "Out of the time span range";
const LOOPS_LIMIT_EXCEEDED_ERROR_MESSAGE = "Invalid expression, loop limit exceeded";
/** And its parse-time refusal of a day no named month has (February 30th). */
const NO_SUCH_DAY_ERROR_PREFIX = "Invalid explicit day of month definition";

/** How far ahead a schedule's next slot may be: an expression with none this close is refused. */
export const CRON_HORIZON_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const CRON_FIELDS = 5;

export type CronCheck = { ok: true } | { ok: false; field: "cron" | "timezone"; message: string };

/**
 * `nextSlot` found no slot within `CRON_HORIZON_DAYS` of `after`. The one error
 * of `nextSlot` that is about the expression rather than the caller: an
 * expression that matched once may have no slot left (a leap day, a year on).
 */
export class NoCronSlotError extends Error {
  constructor(cron: string, timezone: string) {
    super(`cron '${cron}' in ${timezone} has no slot in the next ${CRON_HORIZON_DAYS} days`);
    this.name = "NoCronSlotError";
  }
}

/** The five fields, or why the expression is not five fields `cron-parser` may read. */
function fieldsOf(cron: string): { ok: true; normalised: string } | { ok: false; message: string } {
  const fields = cron.trim().split(/\s+/).filter((f) => f !== "");
  if (fields.length !== CRON_FIELDS) {
    return {
      ok: false,
      message:
        `cron must be exactly five whitespace-separated fields (minute hour day-of-month month ` +
        `day-of-week); it has ${fields.length}`,
    };
  }
  // No month or day name has an 'h' but Thursday's.
  if (fields.some((f) => /h/i.test(f.replace(/thu/gi, "")))) {
    return {
      ok: false,
      message: "cron may not use 'H' (a hashed value): it is drawn afresh on every parse, so it fixes no slot",
    };
  }
  return { ok: true, normalised: fields.join(" ") };
}

/**
 * The IANA zones this runtime's ICU names (`Intl.supportedValuesOf`), plus
 * `UTC`, which the list leaves out. `Intl.DateTimeFormat` alone accepts more
 * than names — an offset (`+05:00`) and legacy abbreviations (`EST`) — so it
 * is not the check by itself.
 */
const IANA_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
/** An `Area/Location` name (`Asia/Kolkata`, `America/Argentina/Buenos_Aires`). */
const AREA_LOCATION = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * Whether `timezone` is an IANA zone name: one the list holds, or an
 * `Area/Location` name the runtime resolves to one it holds. The second arm is
 * for current names ICU lists under their older spelling: it lists
 * `Asia/Calcutta` and `Europe/Kiev`, and resolves `Asia/Kolkata` and
 * `Europe/Kyiv` to them. An offset or an abbreviation is neither.
 */
function zoneKnown(timezone: string): boolean {
  if (IANA_ZONES.has(timezone)) return true;
  if (!AREA_LOCATION.test(timezone)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
  return IANA_ZONES.has(resolved);
}

const ZONE_MESSAGE = "timezone must be an IANA zone name, such as Europe/London or UTC";

/**
 * Whether a schedule may be created with `cron` in `timezone`: five fields
 * `cron-parser` reads, an IANA zone, and a slot within `CRON_HORIZON_DAYS` of
 * `now`. A refusal names the field it is about. Its message may quote a part
 * of the caller's own expression (`cron-parser`'s "got value 60"), never the
 * timezone it was sent: a zone that is not one is answered by the rule alone.
 */
export function parseCron(cron: string, timezone: string, now: Date = new Date()): CronCheck {
  const shape = fieldsOf(cron);
  if (!shape.ok) return { ok: false, field: "cron", message: shape.message };
  if (!zoneKnown(timezone)) return { ok: false, field: "timezone", message: ZONE_MESSAGE };
  try {
    CronExpressionParser.parse(shape.normalised, { currentDate: now, tz: timezone });
  } catch (error) {
    // `cron-parser` refuses at parse a value out of range, a character it does
    // not read, or a day no named month has (February 30th).
    return { ok: false, field: "cron", message: `cron is not a valid expression: ${messageOf(error)}` };
  }
  try {
    nextSlot(cron, timezone, now);
  } catch (error) {
    if (error instanceof NoCronSlotError) {
      return { ok: false, field: "cron", message: `cron has no slot in the next ${CRON_HORIZON_DAYS} days` };
    }
    throw error;
  }
  return { ok: true };
}

/**
 * The first slot of `cron` in `timezone` strictly after `after`.
 *
 * Throws `NoCronSlotError` when there is none within `CRON_HORIZON_DAYS`. Any
 * other throw is the caller's defect: an expression or a zone `parseCron`
 * refuses, which every caller has checked before storing it.
 */
export function nextSlot(cron: string, timezone: string, after: Date): Date {
  if (Number.isNaN(after.getTime())) throw new Error("nextSlot: `after` is not a valid instant");
  const shape = fieldsOf(cron);
  if (!shape.ok) throw new Error(`nextSlot: ${shape.message}`);
  if (!zoneKnown(timezone)) throw new Error(`nextSlot: ${ZONE_MESSAGE}`);
  const endDate = new Date(after.getTime() + CRON_HORIZON_DAYS * DAY_MS);
  let slot: Date;
  try {
    slot = CronExpressionParser.parse(shape.normalised, { currentDate: after, endDate, tz: timezone })
      .next()
      .toDate();
  } catch (error) {
    const message = messageOf(error);
    // Past the end date, or the library's search gave up (31 April or June):
    // either way, no slot in the horizon. Parse refusals (February 30th) are
    // the same verdict about the expression.
    if (
      message === TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE ||
      message === LOOPS_LIMIT_EXCEEDED_ERROR_MESSAGE ||
      message.startsWith(NO_SUCH_DAY_ERROR_PREFIX)
    ) {
      throw new NoCronSlotError(shape.normalised, timezone);
    }
    throw new Error(`nextSlot: cron '${shape.normalised}' in ${timezone}: ${message}`);
  }
  if (!(slot.getTime() > after.getTime())) {
    throw new Error(
      `nextSlot: cron-parser answered ${slot.toISOString()} for a slot strictly after ${after.toISOString()}`,
    );
  }
  return slot;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
