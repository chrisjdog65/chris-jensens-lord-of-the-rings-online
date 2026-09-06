# Rules for module authors (read fully)

1. Read `docs/SPEC.md` completely before writing. It is the contract. Follow names/signatures EXACTLY.
2. Write ONLY your assigned file(s) under `src/js/`. Never edit other modules, `build.js`, the CSS or HTML skeleton.
   If you need a helper another module should own and it isn't in the spec, implement a private copy inside your
   file (prefixed `_`) and note it in the header comment.
3. File shape:
   ```js
   /* ==== NN_name.js — one-paragraph description. Public API summary. ==== */
   (function () {
     'use strict';
     const G = window.G;            // core is loaded first
     ...
     G.Foo = { ... };
   })();
   ```
   Top-level code may only touch `G`, `G.C`, `G.Data.*` (modules that load EARLIER alphabetically) and `THREE`.
   Anything that needs a later module goes inside functions called after `G.emit('init')` / at runtime.
4. No stubs, no TODOs, no "simplified for now". Ship the complete feature described in the spec, with
   the polish of a commercial game. Large files are fine (1,000–4,000 lines is normal here).
5. Runtime hygiene: no allocations in per-frame hot paths (pool vectors/arrays), no `console.error`,
   no `console.log` spam (use `G.log`), no `alert`, no network, no ES modules, no `Date.now()` for gameplay
   time (use `G.time.now` / `G.time.dt`; `performance.now()` is fine for profiling only).
   Every public function must be defensive: if called with a missing entity/target, return gracefully.
6. Deterministic content: world placement/generation must use `G.hash2`, `G.rng(seed)` or `G.noise2/fbm`,
   never `Math.random()` (so the world is identical every load). Gameplay randomness (loot, crits) may use `G.rand()`.
7. Self-check before finishing:
   * `node -e "new Function(require('fs').readFileSync('src/js/<yourfile>','utf8'))"` must print nothing (syntax OK).
   * `node build.js` must succeed (it syntax-checks every module).
   * If your module is testable stand-alone in a browser, write a throwaway harness under `tools/scratch/` (git-ignored
     is not required; just keep it out of `src/`) and run it with the globally installed Playwright
     (`require('/opt/node22/lib/node_modules/playwright')`, launch chromium with args
     `['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']`) to catch runtime errors and
     take a screenshot (`tools/out/*.png`) — LOOK at the screenshot with the Read tool and iterate until it looks good.
     For this you can load `vendor/three.min.js` + `src/js/00_core.js` (if it exists yet; if not, stub the few
     `G` helpers you use inside the harness only) + your file into a test page.
8. Your final message must be a concise report: what you built, the exact public API you exposed (anything beyond
   the spec), assumptions you made about other modules, and known limitations. No code in the report.
