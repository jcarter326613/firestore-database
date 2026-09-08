# Firestore Database

`firestore-database` owns Firebase Admin access, Zod validation,
document IDs, and migrations. Application code defines collections and optional
storage migrations; it never receives raw Firestore objects.

## Installation

```sh
pnpm add firestore-database
```

## Collections

```ts
const collections = {
  recipes: defineCollection({
    path: "recipes",
    schema: z.object({
      title: z.string(),
      normalizedTitle: z.string().optional(),
      ingredientIds: z.array(z.string()).optional(),
    }).strict(),
  }),
  ingredients: defineCollection({
    path: "ingredients",
    schema: z.object({ name: z.string() }).strict(),
  }),
};

const database = createFirestoreDatabase({
  collections,
  databaseId: process.env.FIRESTORE_DATABASE_ID!,
});

const recipe = await database.collections.recipes.create({ title: "Bread" });
await database.collections.recipes.update(recipe.id, (current) => ({
  ...current,
  title: "Sourdough bread",
}));
```

Firestore generates document IDs. Reads return `{ id, data }`; the ID is the
document identity used for subsequent `get`, `set`, `update`, and `delete`
calls, not a field in the Zod schema.

The facade strips stored fields outside the running schema before returning a
document. Release engineers must keep schemas compatible while old and new
application versions overlap: retain old fields and make newly introduced
fields optional until their storage migration has completed. Normal application
writes replace a document with the running schema shape. Older code can remove
newer fields it does not know, so deployments must prevent unsafe version
overlap.

## Migrations

Migrations are the only supported way to deliberately change existing stored
data. Their ordered IDs are recorded in the migration ledger and used as hidden
per-document migration versions. The version is never exposed to application
schemas.

```ts
const migrations = defineDatabaseMigrations<typeof collections>([
  {
    id: "202609071200-split-ingredients",
    description: "Move recipe ingredients into their own documents",
    checksum: migrationChecksum("split ingredients v1"),
    async run(migration) {
      await migration.forEachDocument({
        collection: "recipes",
        name: "split-ingredients",
        async change(recipe, { newId }) {
          const ingredientId = newId("ingredients");

          return [
            {
              type: "set",
              collection: "recipes",
              id: recipe.id,
              data: {
                ...recipe.data,
                ingredientIds: [...(recipe.data.ingredientIds ?? []), ingredientId],
              },
            },
            {
              type: "create",
              collection: "ingredients",
              id: ingredientId,
              data: { name: "Flour" },
            },
          ];
        },
      });
    },
  },
]);
```

`newId` obtains a Firestore auto-ID without writing. For one source document,
all reads, generated-ID writes, source-version update, and progress update run
in one Firestore transaction. A retry commits none of its earlier attempts, so
random child IDs do not create duplicates. One source document must fit within
Firestore's 500-write transaction limit.

Only one migration runner holds the database lease at a time. Application work
continues during a migration. Firestore transactions provide the per-document
lock: a concurrent application write or migration attempt retries when both
touch the same source document.

Run migrations after deploying application code that can read both shapes:

```ts
await database.migrate();
```

Never edit a completed migration ID or checksum. The migration ledger records
failures and completed document-processing steps so rerunning the same release
continues safely.

## Testing

Application tests should mock only the typed collection operations they need.
They do not need Firestore.

The package has fast mocked unit tests and an emulator integration suite:

```sh
pnpm test
pnpm test:integration
```

The integration suite uses the real Firebase Admin SDK and Firestore emulator
to verify transaction ordering, generated IDs, lease contention, and migration
resume behavior. It does not validate production IAM policies or every
production index configuration.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development, pull-request, and
release guidance. Security vulnerabilities must be reported privately as
described in [SECURITY.md](./SECURITY.md).
