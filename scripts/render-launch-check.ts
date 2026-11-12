/**
 * Does Chromium start, sandbox ON, as this process's user, and render one real
 * page through the production renderer? Run in the image (deploy.md):
 *
 *   docker run --rm --entrypoint node ariadne:local --import tsx scripts/render-launch-check.ts [url]
 *
 * The target must be a public URL (url-policy refuses private addresses; there is
 * no trust flag here). Exits non-zero, printing the launch error, on any failure.
 */
import { PageRenderer } from "../src/crawl/render/renderer.js";

const target = process.argv[2] ?? "https://example.com/";
const renderer = await PageRenderer.launch({
  origin: new URL(target).origin,
  htmlDir: "/tmp",
  userAgent: "ariadne-launch-check",
  perHostDelayMs: 0,
});
try {
  const result = await renderer.render(target);
  console.log(JSON.stringify({ url: result.url, rendered: result.rendered, title: result.title, error: result.error }));
  if (!result.rendered) process.exit(1);
} finally {
  await renderer.close();
}
