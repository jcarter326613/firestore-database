# firestore-database

## 0.3.0

### Minor Changes

- e667e17: Allow collections to use any object-output Zod schema, including discriminated unions. Patches now validate the complete merged document before writing changed fields. Remove the obsolete `VersionedDocumentSchema` export.

## 0.2.0

### Minor Changes

- 8adefbb: Replace whole-document collection writes with a transaction-safe, field-scoped
  `patch()`.

    `DatabaseCollection.set()` and `DatabaseCollection.update()` are removed. Use
    `create()` for new documents and `patch(id, updater)` to update named fields.
    `patch()` runs in a Firestore transaction, validates the changed fields and the
    merged document, writes only the fields the updater returns, and preserves the
    hidden `__migrationVersion`. Returning no fields is a no-op.

## 0.1.1

### Patch Changes

- 7f186ce: Add required imports to README examples.

## 0.1.0

### Minor Changes

- d42c142: Initial public release.
