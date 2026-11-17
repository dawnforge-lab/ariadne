# Third-party notices

Ariadne absorbs small amounts of MIT-licensed source (read fully, then owned —
see docs/crawl-audit-build-plan.md §1–3). The MIT licence requires this notice
to travel with the code. Upstream is one-time source material, never synced.

## OpenSEO — https://github.com/every-app/open-seo

Copyright (c) 2026 Ben Senescu. MIT License.
Absorbed at commit c469a48ae90ab58413b198fe3d1ac1aa90a9b070 (see provenance
headers in the affected files under src/crawl/ and src/rules/registry/copy/).

The badseo fixture site's page content (`badseo/src/fixtures/`, `badseo/src/lib.ts`)
was absorbed at the same commit into test/fixtures/ — see the provenance headers
in test/fixtures/render.ts and test/fixtures/pages/absorbed.ts.

## SEOnaut — https://github.com/StJudeWasHere/seonaut

Copyright (c) 2022 SEOnaut. MIT License.
Issue copy absorbed at commit
880b312c28fab8b0bf7fe4f9449dc4746dbb82ff (Phase 2).

## MIT License text

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The copyright line above is supplied per source in the sections above; the
licence body is identical for both and reproduced once here.

## npm dependencies

undici, htmlparser2, robots-parser, pg, drizzle-orm,
playwright, @modelcontextprotocol/sdk, zod — each under its own licence as
published on npm; see node_modules/<pkg>/LICENSE.

@modelcontextprotocol/sdk (MIT, verified at install: `npm info
@modelcontextprotocol/sdk license`) and zod (MIT) are runtime dependencies of
the MCP transport (src/api/mcp.ts): the SDK supplies the protocol and the
stdio/in-memory transports, zod the tool input schemas the server advertises
and validates against. No source from either is lifted into this repository.

Playwright (Apache-2.0) is a runtime dependency of the render pass
(src/crawl/render). It downloads a Chromium build on `npx playwright install
chromium`; that browser is not vendored into this repository and carries its
own upstream licences.

## axe-core — https://github.com/dequelabs/axe-core

axe-core 4.14.0, pinned exactly (`"axe-core": "4.14.0"`, no caret), is a
runtime dependency of the render pass's accessibility run (Phase 29b,
src/crawl/render/a11y.ts). Copyright (c) 2015 - 2026 Deque Systems, Inc. Mozilla Public
License 2.0 (https://www.mozilla.org/en-US/MPL/2.0/); the full text ships in
node_modules/axe-core/LICENSE. **Unmodified**: the package's own
`axe.min.js` is read from node_modules at run time and evaluated in the
rendered page as published. No axe-core source is copied into this
repository, and no file of it is changed, so MPL-2.0's file-level copyleft
asks nothing further of Ariadne's own files. Its source is available at the
URL above (tag v4.14.0) and on npm.

axe-core bundles third-party code under its own licences, listed in
node_modules/axe-core/LICENSE-3RD-PARTY.txt:

- MIT: colorjs.io (Lea Verou, Chris Lilley), core-js-pure (Denis Pushkarev),
  css-selector-parser (Dulin Marat), doT.js (Laura Doktorova; portions from
  jQote2, aefxx), emoji-regex (Mathias Bynens), es6-iterator, event-emitter
  and lru-queue (Mariusz Nowak), es6-promise (Yehuda Katz, Tom Dale, Stefan
  Penner and contributors), is-promise (Forbes Lindesay), typedarray (Linden
  Research, Inc.; Joshua Bell), weakmap-polyfill (polygonplanet).
- ISC: d, es5-ext, es6-symbol, es6-weak-map, ext, memoizee, next-tick,
  timers-ext and type (Mariusz Nowak).

## schema.org vocabulary

Derived data in `src/rules/schema-org/vocabulary.generated.ts`; release 30.1
(2026-09-16); CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/);
© schema.org contributors. Changes as in the file header: attic terms dropped;
enumeration members dropped; comments/labels dropped. Regenerated only by
`scripts/derive-schema-org.ts`, never synced automatically.
