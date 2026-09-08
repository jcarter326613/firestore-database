# Contributing

## Setup

This project requires Node.js 22 or later and pnpm 11. Enable Corepack, then
install dependencies:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Before opening a pull request, run:

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

Run `pnpm test:integration` when changing Firestore behavior, transactions, or
migrations. It starts a local Firestore emulator.

## Pull requests

Use a focused branch and pull request. Explain the behavior change, include
tests for production code changes, and keep the public API documented in the
README.

`main` is protected. All changes merge through pull requests after CI and
review pass.

## Releases

Changesets determine package versions. Add one to every pull request that
changes the published package:

```sh
pnpm changeset
```

Select the appropriate increment:

- `patch`: backwards-compatible bug fix.
- `minor`: backwards-compatible public API addition.
- `major`: a breaking public API or behavior change.

While the package is below `1.0.0`, a `minor` release may include breaking
changes. Do not add a changeset for documentation, CI, test-only, or other
changes that cannot affect consumers.

CI enforces this rule when it detects published-package changes. For a source
change that deliberately has no release impact, run `pnpm changeset --empty`
and commit the generated file.

After a changeset-bearing pull request merges, the release workflow opens or
updates a `Version Packages` pull request. Merging that pull request publishes
the version, creates its Git tag, and creates the GitHub release.
