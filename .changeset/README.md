# Changesets

Add a changeset to every pull request that changes the published package.

Run `pnpm changeset`, select `firestore-database`, choose the semantic-version
impact, and describe the user-visible change. Commit the generated Markdown
file with the pull request.

Do not add a release changeset for documentation, test, CI, or internal-only
changes that do not affect the published package. If CI requires one for a
source change with no release impact, run `pnpm changeset --empty` instead.

## Beta releases

To test a release through npm before making it the default version, first add
the normal release changeset, then enter prerelease mode:

```sh
pnpm changeset pre enter beta
```

Commit the generated `.changeset/pre.json` file through a pull request. The
automated `Version Packages` pull request will create a version such as
`0.1.2-beta.0`. Merging it publishes the package under the `beta` dist-tag;
the `latest` tag remains on the current stable version.

Install the candidate in a consumer project with:

```sh
pnpm add firestore-database@beta
```

Additional changesets merged while prerelease mode is active create subsequent
beta versions. When the candidate is approved, exit prerelease mode:

```sh
pnpm changeset pre exit
```

Commit `.changeset/pre.json` through a pull request. The next `Version
Packages` pull request removes the prerelease suffix and publishes the final
version as `latest`.

Prerelease mode applies to every release from `main` until it is exited. Keep
the beta window short, or use a dedicated release branch with separate release
automation for longer-running beta work.
