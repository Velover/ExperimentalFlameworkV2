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
| what can change a byte on the wire: `buildSerializerFromType.ts`, the packing in `transformNetworkingCall.ts`, the networking runtime's packed paths | also `bun run build`, then `bun run test:runtime`: its `golden layouts` suite writes every sample of `packages/specs/src/golden/layouts.ts` and compares the bytes with `packages/specs/golden`, then reads each golden back. A deliberate layout change only: `bun run test:runtime --update-golden` rewrites the goldens on any shell (the Server run writes, the Client run checks), committed with a CHANGELOG upgrade note | 3 min |
| packaging: a package's `files`, `scripts/copy-*.mjs`, `scripts/links.mjs` | `bun run test:packaging` | 1 min |
| behaviour only the engine shows (signals, replication, streaming) | `bun run test:place --project default.project.json --sections <section>`, one project; all four projects: `bun run test:place --parallel 2` (the place's default; `--parallel 1` only for timing or a window's focus) | several min, Studio; all four projects about 5 min with `--parallel 2`, 7 min 20 s one after another |

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

## Waiting for long commands: don't poll

- Run a long command (a test run, a full build, Studio) in the background and let its completion
  notification wake you. Don't keep reading its log or sleeping and looking again.
- No polling: it costs a lot of usage. Two health checks of your own are allowed if needed
  (reading its log, a status command): one near the start (did it start properly) and one midway.
  More only when the user asks for them. The user asking how it is going is not one of yours.
- Next to a long command, start a watcher in the background that ends, and so wakes you, when
  something goes wrong: the first failure line, the log silent for minutes (a hang), or the command
  dying without finishing. Its own checking is not your polling.
- Commands that finish in a minute or two need none of this: run them in the foreground, with a
  timeout.
