# Changesets

Add a changeset to every pull request that changes the published package.

Run `pnpm changeset`, select `firestore-database`, choose the semantic-version
impact, and describe the user-visible change. Commit the generated Markdown
file with the pull request.

Do not add a release changeset for documentation, test, CI, or internal-only
changes that do not affect the published package. If CI requires one for a
source change with no release impact, run `pnpm changeset --empty` instead.
