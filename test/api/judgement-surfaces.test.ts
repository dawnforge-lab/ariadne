/**
 * The read surfaces apply a crawl's judgement at READ time (Phase 27a T5).
 *
 * A rules run stores every rule's findings, disabled ones included; what a
 * reader sees is decided when it reads, through one loader
 * (`src/api/judgement-view.ts`): `issues_list`, `issue_urls` / `issue_inlinks`,
 * `rules_catalog`, the issues CSV and the JSONL export. Disabling a rule hides
 * its findings at once, and re-enabling brings them back without a re-run;
 * retyping and reprioritising show up immediately with an `…Overridden` flag;
 * a threshold override shows up in the copy only after the rules re-run, and
 * the staleness in between is reported, never hidden.
 *
 * The judgement block is written straight into `crawls.judgement_jsonb` here:
 * the tool that sets it lands in Task 6.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { CSV_VIEWS } from "../../src/api/csv.js";
import {
  ApiService,
  type CsvExportResult,
  type ExportResult,
  type IssueGroup,
} from "../../src/api/service.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://judgement-surfaces.example";
const LONG_TITLE = "A page title written well past the sixty characters a result shows"; // 66
const MARKERS = new Set(
  buildRegistry()
    .all()
    .filter((rule) => rule.marker !== undefined)
    .map((rule) => rule.id),
);

let db: Db;
let service: ApiService;
let exportDir: string;
const crawlId = `crawl_judgement_surfaces_${randomUUID()}`;

async function setJudgement(block: unknown): Promise<void> {
  await db.update(crawls).set({ judgement: block }).where(eq(crawls.id, crawlId));
}

async function allGroups(): Promise<
  Awaited<ReturnType<ApiService["listIssues"]>> & { items: IssueGroup[] }
> {
  return await service.listIssues(LOCAL_TENANT, crawlId, { limit: 200 });
}

function group(groups: IssueGroup[], ruleId: string): IssueGroup | undefined {
  return groups.find((g) => g.ruleId === ruleId);
}

async function csvLines(view: string): Promise<string[]> {
  const stream = await service.prepareCsvExport(LOCAL_TENANT, crawlId, { view });
  const out: string[] = [];
  for await (const record of stream.records()) out.push(record.replace(/\r\n$/, ""));
  return out;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-judgement-surfaces-"));
  service = new ApiService(db, { allowedDomains: [], exportDir, log: () => {} });

  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id: crawlId,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 3,
  });
  const page = (path: string, overrides: Parameters<typeof mkPage>[0] = {}) => {
    const url = `${SITE}${path}`;
    return mkPage({
      id: `page_${randomUUID()}`,
      crawlId,
      url,
      urlNormalised: url,
      ...overrides,
    });
  };
  await db.insert(pages).values([
    page("/", { depth: 0, clickDepth: 0, discoveredVia: "seed" }),
    page("/long", { title: LONG_TITLE }),
    page("/no-meta", { title: "A second perfectly reasonable title", metaDescription: null }),
  ]);

  // Judged with no overrides: the stamp's disabled set is empty.
  await service.runRulesForCrawl(LOCAL_TENANT, crawlId);
});

afterAll(async () => {
  await service.close();
  await db.delete(crawls).where(eq(crawls.id, crawlId));
  await closeDb(db);
  rmSync(exportDir, { recursive: true, force: true });
});

describe("the fixture", () => {
  it("fires title.too-long, meta-description.missing and at least one marker", async () => {
    const { items } = await allGroups();
    expect(group(items, "title.too-long")?.count).toBeGreaterThan(0);
    expect(group(items, "meta-description.missing")?.count).toBeGreaterThan(0);
    expect(items.some((g) => MARKERS.has(g.ruleId))).toBe(true);
  });
});

describe("rule overrides apply at read time", () => {
  const OVERRIDES = {
    rules: {
      "title.too-long": { disabled: true },
      "meta-description.missing": { priority: "low", type: "opportunity" },
    },
  };

  it("issues_list drops the disabled rule, names it, and carries the overrides", async () => {
    await setJudgement(OVERRIDES);
    const page = await allGroups();

    expect(group(page.items, "title.too-long")).toBeUndefined();
    expect(page.disabledRules).toEqual(["title.too-long"]);

    const meta = group(page.items, "meta-description.missing");
    expect(meta).toMatchObject({
      type: "opportunity",
      typeOverridden: true,
      priority: "low",
      priorityOverridden: true,
    });

    const marker = page.items.find((g) => MARKERS.has(g.ruleId));
    expect(marker).toBeDefined();
    expect(marker?.type).toBe("warning");
    expect(marker?.priority).toBe("low");
    expect(marker).not.toHaveProperty("typeOverridden");
    expect(marker).not.toHaveProperty("priorityOverridden");

    // The run's stamp has no disabled rule; the block now has one.
    expect(page.judgementStale).toEqual({ stale: true, reasons: ["overrides"] });
  });

  it("issue_urls and issue_inlinks refuse a disabled rule with CONFLICT naming it", async () => {
    await setJudgement(OVERRIDES);
    await expect(service.listIssueUrls(LOCAL_TENANT, crawlId, "title.too-long")).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        `rule 'title.too-long' is disabled on crawl '${crawlId}'; re-enable it with ` +
        "crawl_config_set to list its findings",
    });
    await setJudgement({ rules: { "links.broken-internal": { disabled: true } } });
    await expect(
      service.listIssueInlinks(LOCAL_TENANT, crawlId, "links.broken-internal"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.listIssueInlinks(LOCAL_TENANT, crawlId, "links.broken-internal"),
    ).rejects.toThrow(/links\.broken-internal/);
  });

  it("rules_catalog keeps the disabled rule, flags it, and still counts its stored findings", async () => {
    await setJudgement(OVERRIDES);
    const catalog = await service.rulesCatalog(LOCAL_TENANT, { crawlId });
    const rules = new Map(catalog.rules.map((r) => [r.id, r]));

    const disabled = rules.get("title.too-long");
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.fired?.count).toBeGreaterThan(0);

    const meta = rules.get("meta-description.missing");
    expect(meta).toMatchObject({
      type: "opportunity",
      typeOverridden: true,
      priority: "low",
      priorityOverridden: true,
    });
    expect(meta).not.toHaveProperty("disabled");

    const health = rules.get("site.health");
    expect(health).toBeDefined();
    expect(health).not.toHaveProperty("type");
    expect(health).not.toHaveProperty("priority");

    expect(catalog.judgementStale).toEqual({ stale: true, reasons: ["overrides"] });
    expect(catalog.thresholds?.TITLE_MAX).toBe(60);
  });

  it("the issues CSV carries type and priority and leaves out the disabled rule", async () => {
    await setJudgement(OVERRIDES);
    const lines = await csvLines("issues");
    expect(lines[0]).toBe("ruleId,severity,type,priority,category,checkIds,url,title,evidence");
    expect(lines.some((l) => l.startsWith("title.too-long,"))).toBe(false);
    const meta = lines.find((l) => l.startsWith("meta-description.missing,"));
    expect(meta?.split(",").slice(0, 4)).toEqual([
      "meta-description.missing", "warning", "opportunity", "low",
    ]);
  });

  it("the issue_urls CSV of a disabled rule is refused before a byte", async () => {
    await setJudgement(OVERRIDES);
    await expect(
      service.prepareCsvExport(LOCAL_TENANT, crawlId, { view: "issue_urls", ruleId: "title.too-long" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the CSV export answer names the disabled rules on the four views that read findings", async () => {
    await setJudgement(OVERRIDES);
    const FINDINGS_VIEWS = new Set(["issues", "issue_urls", "issues_overview", "crawl_overview"]);
    for (const view of CSV_VIEWS) {
      const opts =
        view === "issue_urls"
          ? { view, ruleId: "meta-description.missing" }
          : view === "metric_table"
            ? { view, metricId: "site.health" }
            : { view };
      const result = (await service.exportCrawl(LOCAL_TENANT, crawlId, {
        format: "csv",
        ...opts,
      })) as CsvExportResult;
      if (FINDINGS_VIEWS.has(view)) {
        expect(result.disabledRules, view).toEqual(["title.too-long"]);
      } else {
        expect(result, view).not.toHaveProperty("disabledRules");
      }
    }
    // An empty disabled set is stated, not omitted.
    await setJudgement({});
    const clean = (await service.exportCrawl(LOCAL_TENANT, crawlId, {
      format: "csv",
      view: "issues_overview",
    })) as CsvExportResult;
    expect(clean.disabledRules).toEqual([]);
  });

  it("the JSONL issues export leaves out the disabled rule and names it in its manifest", async () => {
    await setJudgement(OVERRIDES);
    const result = (await service.exportCrawl(LOCAL_TENANT, crawlId, { dataset: "issues" })) as ExportResult;
    expect(result.disabledRules).toEqual(["title.too-long"]);
    const rows = gunzipSync(readFileSync(result.path))
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.length).toBe(result.rows);
    expect(rows.some((r) => r["ruleId"] === "title.too-long")).toBe(false);
    expect(rows.some((r) => r["ruleId"] === "meta-description.missing")).toBe(true);
    // Every row carries the crawl's type and priority, after its overrides,
    // exactly as the `issues` CSV view's columns do.
    const csv = (await csvLines("issues")).slice(1).map((line) => line.split(","));
    const csvTriage = new Map(csv.map((cells) => [cells[0], `${cells[2]}/${cells[3]}`]));
    for (const row of rows) {
      expect(row, String(row["ruleId"])).toHaveProperty("type");
      expect(row, String(row["ruleId"])).toHaveProperty("priority");
      expect(`${String(row["type"])}/${String(row["priority"])}`).toBe(
        csvTriage.get(String(row["ruleId"])),
      );
    }
    const meta = rows.find((r) => r["ruleId"] === "meta-description.missing");
    expect(meta).toMatchObject({ type: "opportunity", priority: "low" });
    const marker = rows.find((r) => MARKERS.has(String(r["ruleId"])));
    expect(marker).toMatchObject({ type: "warning", priority: "low" });

    // The other datasets are not about findings and carry no such field.
    const pagesExport = (await service.exportCrawl(LOCAL_TENANT, crawlId, { dataset: "pages" })) as ExportResult;
    expect(pagesExport).not.toHaveProperty("disabledRules");
  });

  it("a stored override of a rule the ruleset lacks is a CONFLICT naming the rule", async () => {
    await setJudgement({ rules: { "gone.rule": { disabled: true } } });
    try {
      await expect(service.listIssues(LOCAL_TENANT, crawlId)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(service.listIssues(LOCAL_TENANT, crawlId)).rejects.toThrow(/gone\.rule/);
      await expect(service.listIssues(LOCAL_TENANT, crawlId)).rejects.toThrow(new RegExp(crawlId));
    } finally {
      await setJudgement(null);
    }
  });

  it("a malformed stored block is the loud error, never 'no overrides'", async () => {
    await setJudgement({ rules: { "title.too-long": { severity: "info" } } });
    try {
      const failure = await service.listIssues(LOCAL_TENANT, crawlId).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("JudgementError");
      expect((failure as Error).message).toContain(crawlId);
    } finally {
      await setJudgement(null);
    }
  });

  it("re-enabling brings the findings back at once, and the judgement is no longer stale", async () => {
    await setJudgement(OVERRIDES);
    expect(group((await allGroups()).items, "title.too-long")).toBeUndefined();

    await setJudgement(null);
    const page = await allGroups();
    expect(group(page.items, "title.too-long")?.count).toBeGreaterThan(0);
    expect(page.disabledRules).toEqual([]);
    expect(page.judgementStale).toEqual({ stale: false, reasons: [] });
  });
});

describe("threshold overrides apply at the next run, and the copy follows the stamp", () => {
  it("quotes the stamped value until the rules re-run, and reports the staleness", async () => {
    await setJudgement({ thresholds: { TITLE_MAX: 50 } });

    const before = await service.rulesCatalog(LOCAL_TENANT, { crawlId });
    const tooLong = before.rules.find((r) => r.id === "title.too-long");
    expect(tooLong?.explanation).toContain("60 characters");
    expect(before.judgementStale).toEqual({ stale: true, reasons: ["thresholds"] });
    expect(before.thresholds?.TITLE_MAX).toBe(60);

    await service.runRulesForCrawl(LOCAL_TENANT, crawlId);

    const after = await service.rulesCatalog(LOCAL_TENANT, { crawlId });
    const rerun = after.rules.find((r) => r.id === "title.too-long");
    expect(rerun?.explanation).toContain("50 characters");
    expect(rerun?.explanation).not.toContain("60 characters");
    expect(after.judgementStale).toEqual({ stale: false, reasons: [] });
    expect(after.thresholds?.TITLE_MAX).toBe(50);

    // The listing's title is the same rendering.
    const page = await allGroups();
    expect(group(page.items, "title.too-long")?.title).toContain("50");
  });

  it("without a crawl the catalog is the default rendering, with type and priority and no judgement fields", async () => {
    const catalog = await service.rulesCatalog(LOCAL_TENANT);
    expect(catalog).not.toHaveProperty("judgementStale");
    expect(catalog).not.toHaveProperty("thresholds");
    const tooLong = catalog.rules.find((r) => r.id === "title.too-long");
    expect(tooLong?.explanation).toContain("60 characters");
    expect(tooLong?.type).toBe("opportunity");
    expect(tooLong?.priority).toBe("medium");
    expect(tooLong).not.toHaveProperty("disabled");
    expect(tooLong).not.toHaveProperty("typeOverridden");
    const health = catalog.rules.find((r) => r.id === "site.health");
    expect(health).not.toHaveProperty("type");
  });
});

describe("an unjudged crawl", () => {
  it("is never stale, and renders its copy from the current block", async () => {
    const id = `crawl_judgement_unjudged_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${SITE}/`,
      config: { siteUrl: `${SITE}/` },
      judgement: { thresholds: { TITLE_MAX: 55 }, rules: { "title.too-long": { disabled: true } } },
      rulesetVersion: "test",
      status: "finished",
    });
    try {
      const page = await service.listIssues(LOCAL_TENANT, id);
      expect(page.items).toEqual([]);
      expect(page.disabledRules).toEqual(["title.too-long"]);
      expect(page.judgementStale).toEqual({ stale: false, reasons: [] });

      const catalog = await service.rulesCatalog(LOCAL_TENANT, { crawlId: id });
      expect(catalog.judgementStale).toEqual({ stale: false, reasons: [] });
      expect(catalog.thresholds?.TITLE_MAX).toBe(55);
      expect(catalog.rules.find((r) => r.id === "title.too-long")?.explanation).toContain(
        "55 characters",
      );
    } finally {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
  });

  it("a judged crawl with no stamp is a loud error naming the crawl", async () => {
    const id = `crawl_judgement_nostamp_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${SITE}/`,
      config: { siteUrl: `${SITE}/` },
      rulesetVersion: "test",
      status: "finished",
      rulesRunAt: new Date(),
    });
    try {
      await expect(service.listIssues(LOCAL_TENANT, id)).rejects.toThrow(
        new RegExp(`crawl ${id}: judged .* rules_judged_with_jsonb is missing`),
      );
    } finally {
      await db.delete(crawls).where(eq(crawls.id, id));
    }
  });
});
