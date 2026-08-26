# Third-party notices

Ariadne absorbs small amounts of MIT-licensed source (read fully, then owned —
see docs/crawl-audit-build-plan.md §1–3). The MIT licence requires this notice
to travel with the code. Upstream is one-time source material, never synced.

## OpenSEO — https://github.com/every-app/open-seo

Copyright (c) 2026 Ben Senescu. MIT License.
Absorbed at commit c469a48ae90ab58413b198fe3d1ac1aa90a9b070 (see provenance
headers in the affected files under src/crawl/).

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

undici, htmlparser2, robots-parser, fast-xml-parser, pg, drizzle-orm — each
under its own licence as published on npm; see node_modules/<pkg>/LICENSE.
