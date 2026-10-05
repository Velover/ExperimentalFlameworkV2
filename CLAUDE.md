# Flamework monorepo

## Tests: run what the change can break

Match the testing to the change. The whole set takes over a quarter of an hour, plus Studio, so a
small change never needs it.

| The change | Run | Takes about |
|---|---|---|
| docs, comments, the CHANGELOG | nothing, unless the links of a shipped page changed (`docs/README.md`, `docs/guide/`, `docs/ai/`, a README): then `bun run test:packaging` | 1 min |
| `packages/testing/cli` | `bun test packages/testing/cli/tests` (one file when the change is local) and `tsc -p packages/testing/cli` | 20 s |
| runtime code in `packages/core`, `components`, `networking`, `testing/src` | `bun run build`, then `bun run test:runtime` | 3 min |
| `packages/transformer` | the test files of that area: `bun test --timeout 120000 packages/transformer/tests/<file>` | 1–3 min |
| packaging: a package's `files`, `scripts/copy-*.mjs`, `scripts/links.mjs` | `bun run test:packaging` | 1 min |
| behaviour only the engine shows (signals, replication, streaming) | `bun run test:place --sections <section>`, one project | several min, Studio; all four projects 7 min 20 s, about 5 min with `--parallel 2` |

- **Ask first, saying why and how long:**
  - `bun run test` (every suite);
  - the whole `test:unit` (about 12 min);
  - `test:runtime` with the serialization switch both ways;
  - `test:place` across all its projects;
  - cloud runs and benchmarks.
  Suggest them before a release; run them once the user agrees.
- Don't rerun a suite that passed unless something it covers changed since. After a flaky
  failure, rerun that one test.
- Give subagents the same budget: name the tests they may run.
- Say what you ran and what you skipped.
