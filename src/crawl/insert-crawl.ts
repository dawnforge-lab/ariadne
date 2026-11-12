/**
 * The one way a crawl is created (Phase 28c): `crawl_start` (`ApiService.
 * startCrawl`) and a schedule's fire (the scheduler) both call `insertCrawl`
 * inside their own transaction, so a fired crawl is stored exactly as a
 * started one is — the same row, the same encrypted credentials, the same
 * listed URLs, the same crawl job — and the two cannot drift.
 *
 * Everything is written in the caller's transaction: the crawl row whose
 * `credential_shape` names its credentials and the encrypted values, the
 * `list_urls` its config counts, and the job that will run it. A reader sees
 * all of them or none (28b: an accepted crawl always has the work that runs
 * it).
 */
import { hostKeyOf } from "./host-key.js";
import type { CredentialVault } from "./credential-vault.js";
import type { CrawlCredentials } from "./credentials.js";
import type { storableConfig } from "./loop.js";
import type { Db } from "../db/client.js";
import { crawls, listUrls } from "../db/schema.js";
import type { JudgementBlock } from "../rules/judgement.js";
import { RULESET_VERSION } from "../rules/registry/registry.js";
import type { TenantId } from "../tenant.js";
import { enqueueJob } from "../worker/jobs.js";

/**
 * What a crawl stores in `config_jsonb`: its effective config, less the
 * test-only fields and the credentials (`storableConfig`), plus — on a list
 * crawl — how many listed URLs were collapsed as duplicates (27c Deviation 3),
 * which the loop never reads.
 */
export type StoredConfig = ReturnType<typeof storableConfig> & { listDuplicates?: number };

/** A chain's render link: render the crawl's selection, or exactly `urls`. */
export interface ChainRender {
  urls?: string[];
}

/**
 * `crawls.schedule_chain`: what runs after a fired crawl settles. Non-null
 * exactly when a schedule fired the crawl; `render: null` is a chain of the
 * rules link alone.
 */
export interface ScheduleChain {
  render: ChainRender | null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** `list_urls` rows per INSERT: three parameters a row, well under Postgres' 65,535. */
const LIST_INSERT_CHUNK = 1000;

export interface InsertCrawl {
  tenant: TenantId;
  crawlId: string;
  config: StoredConfig;
  /** `storableBlock()`'s output, or null when the request named no judgement. */
  judgement: JudgementBlock | null;
  /** The values to encrypt beside the row; absent when the crawl has none. */
  credentials?: CrawlCredentials;
  /** A list crawl's distinct URLs in list order; null on a spider crawl. */
  listed: string[] | null;
  /** The instance that must run the crawl job; absent for any runner. */
  pinnedTo?: string;
  /** The schedule that fired the crawl — given exactly when `chain` is. */
  scheduleId?: string;
  chain?: ScheduleChain;
}

/**
 * Insert the crawl row (`queued`, this code's ruleset), its credentials
 * through the vault, its `list_urls` (`position` from 0 in list order) and its
 * crawl job, inside `tx`. Throws before writing anything on a schedule without
 * a chain or a chain without a schedule: either is the caller's defect.
 */
export async function insertCrawl(tx: Tx, vault: CredentialVault, c: InsertCrawl): Promise<void> {
  if ((c.scheduleId === undefined) !== (c.chain === undefined)) {
    throw new Error(
      `insertCrawl: crawl ${c.crawlId}: scheduleId and chain are given together (a fired crawl) or not at all`,
    );
  }
  await tx.insert(crawls).values({
    id: c.crawlId,
    tenantId: c.tenant,
    siteUrl: c.config.siteUrl,
    hostKey: hostKeyOf(c.config.siteUrl),
    config: c.config,
    // Null when the request named no judgement — "no overrides", the state
    // every crawl before 27a is in.
    judgement: c.judgement,
    rulesetVersion: RULESET_VERSION,
    status: "queued",
    ...(c.scheduleId === undefined ? {} : { scheduleId: c.scheduleId, scheduleChain: c.chain }),
  });
  // The values, encrypted, in the transaction that creates the row whose
  // `credentialShape` names them: a reader sees both or neither (28b).
  if (c.credentials !== undefined) await vault.write(tx, c.tenant, c.crawlId, c.credentials);
  // The distinct listed URLs, `position` from 0 in list order (Deviation 2).
  if (c.listed !== null) {
    const urls = c.listed;
    for (let start = 0; start < urls.length; start += LIST_INSERT_CHUNK) {
      await tx.insert(listUrls).values(
        urls
          .slice(start, start + LIST_INSERT_CHUNK)
          .map((url, offset) => ({ crawlId: c.crawlId, position: start + offset, url })),
      );
    }
  }
  // The run, as a job in the same transaction: an accepted crawl always has
  // the work that will run it (28b).
  await enqueueJob(tx, {
    tenant: c.tenant,
    crawlId: c.crawlId,
    kind: "crawl",
    ...(c.pinnedTo === undefined ? {} : { pinnedTo: c.pinnedTo }),
  });
}
