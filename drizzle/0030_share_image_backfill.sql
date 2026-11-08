-- Phase 26c: 0029 added resources.share_image with default false. A crawl from
-- Phase 26b defined a share image as a resources row with no page_resources
-- edge, so mark those rows; older crawls are then judged exactly as before.
UPDATE resources r SET share_image = true WHERE NOT EXISTS (SELECT 1 FROM page_resources pr WHERE pr.crawl_id = r.crawl_id AND pr.resource_url = r.url);
