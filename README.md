[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mochhidayah/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mochhidayah/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for make.fun's own makefun-site 1.0.0 — identical answers,
less CPU, built for make.fun.

## What it does

`run(input)` returns exactly the output tree makefun-site's `build` returns
for the same input: every page, index page, tag page, static file and
`build-report.txt`, byte for byte. `main.ts` is the driver the harness runs:
it reads every case from `/input/cases.json`, answers each one alone with
`run()`, and writes `/output/answers.json`.

## How it is faster

One file, no dependencies, no I/O, no clock, no randomness. The speed comes
from doing the same work with less of it:

- **Markdown in one pass.** Bodies are rendered straight to HTML while they
  are scanned — no lex-then-render token array, no intermediate strings for
  blocks. Inline text is found by one native scan for the next character
  that matters; plain stretches are copied whole.
- **Escaping that skips clean strings.** The escaper first asks the native
  regex engine whether a string holds anything to escape, and returns it
  untouched when it does not.
- **Fast slugs.** Plain ASCII titles take a short path with no normaliser
  and no regex; only the rare non-ASCII title pays for NFKD.
- **Cards built once.** Reading minutes and tag links are worked out once
  per source and read back, instead of once per list and once per page.
- **Templates compiled.** Each template compiles to a plain function:
  native loops for `for`, native `if`, and a loop variable read straight off
  its local instead of through a scope walk. Where `new Function` is
  unavailable the tree interpreter in the same file renders instead, with
  the same answer.

## Measured

On the kit's practice set (3 cases, 250–480 Markdown sources each),
`run()` takes ~140 ms against the house baseline's ~500 ms on this machine —
about **3.5× faster**, with every case byte-identical to makefun-site 1.0.0
(verified on the practice set plus 180 randomly drawn sites).

## Layout

- `main.ts` — the driver the harness runs.
- `solve.js` — the whole build: front matter, Markdown, templates, output tree.
- `package.json` — `{"type": "module"}`.
