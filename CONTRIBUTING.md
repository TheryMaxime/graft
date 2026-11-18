# Contributing to Graft

Thank you for helping. Bug reports, documentation fixes and code changes are all welcome. Everyone
taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **A security problem:** do not open an issue. Report it privately, as [SECURITY.md](SECURITY.md) describes.
- **A bug or a small fix:** open an issue or go straight to a pull request.
- **A new feature, or a change to the safety core** (`src/github/`, `src/webhooks/`, `src/modes/`,
  `src/policy/`, `src/guard/`, `src/mcp/`, the audit log, the migrations, the workflows): open an
  issue first, so the design is agreed before you write code. [`graft.yaml`](graft.yaml) lists these
  paths; a change to them always needs a maintainer's review.

## Setup

You need Node 24 (`.nvmrc`), pnpm 11 and Docker. No GitHub App and no API key are needed.

```sh
pnpm install
pnpm db:up            # Postgres on 127.0.0.1:55432, for the integration tests
cp .env.example .env
```

The [README quickstart](README.md#quickstart-offline-under-5-minutes) and
[docs/getting-started.md](docs/getting-started.md) go further: running the server and the worker,
sending a test webhook, every script. The console is its own pnpm project: run `pnpm install` in
`console/` as well when you work on it.

## Checks to run

```sh
pnpm lint && pnpm typecheck        # Biome and tsc; `pnpm format` fixes what Biome can
pnpm test:unit                     # needs nothing running
pnpm test:integration              # needs `pnpm db:up`
pnpm eval:ci                       # the synthetic evaluation set against its saved baseline
pnpm graft policy schema --check   # the generated graft.yaml JSON Schema is up to date
```

For the console, in `console/`: `pnpm typecheck`, `pnpm test` and `pnpm build`. For the
documentation or the website: `bash scripts/build-site.sh` (after
`pip install -r requirements-docs.txt`), which builds in strict mode and fails on a broken link.
CI runs all of these on every pull request.

## Rules every change follows

These come from the [Phase 0 constraints](docs/phase-0/README.md#constraints-for-every-step) and
still bind:

- **Tests are offline.** No default test reaches GitHub or a model provider: use the fakes in
  `test/helpers/`. No test asserts wall-clock time.
- **No code is stored or logged.** File contents, diffs, PR titles and PR bodies never go into the
  database or the logs: only ids, numbers, SHAs, paths and the model's own prose.
- **Report mode stays the default.** Nothing may write more to GitHub than the repository's mode
  allows; new GitHub writes go through the write allow-list in `src/modes/`.
- **Never commit credentials.** `.env`, `*.pem` and key files are git-ignored. Use obviously fake
  values in tests.
- Strict TypeScript, pnpm, Node 24. The import rules between folders are in
  [docs/architecture.md](docs/architecture.md#source-layout).

## Pull requests

- Keep a pull request to one concern, and say what it changes and why in the description.
- Add or update tests with a behavior change, and the docs with a user-visible one. Add a line under
  **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything an operator or user would notice.
- Update `.env.example` and [docs/configuration.md](docs/configuration.md) when you add a setting.
- Graft reviews its own pull requests in report mode: expect a Graft comment and three neutral
  check runs on yours. They inform the reviewer and never block.

### Changes written with a coding agent

Agent-written changes are welcome, and Graft should know about them. End each such commit message
(or the pull request description) with the provenance trailers, as [CLAUDE.md](CLAUDE.md) and
[docs/features/provenance.md](docs/features/provenance.md) describe:

```text
Graft-Agent: <the agent, for example claude-code>
Graft-Model: <the model id>
Graft-Task: <an issue reference such as #42, when there is one>
```

Never invent a `Graft-Session` value. You remain responsible for a change an agent wrote for you:
read it before you open the pull request.

## License of contributions

Graft is licensed under the [Apache License, Version 2.0](LICENSE). As section 5 of the license
says, a contribution you submit is under the same license, with no additional terms. Only submit
work you have the right to contribute.
