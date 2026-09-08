export {
  DatabaseMigrationRequiredError,
  MigrationLeaseLostError,
  MigrationLeaseUnavailableError,
} from "./errors.js";
export {
  createFirestoreDatabase,
  defineCollection,
  defineDatabaseMigrations,
  DocumentValidationError,
  ReservedDocumentPropertyError,
} from "./database.js";
export { migrationChecksum } from "./registry.js";
export type {
  CollectionDefinition,
  CollectionDocument,
  DatabaseCollection,
  DatabaseCollections,
  DatabaseDocumentOperation,
  DatabaseMigration,
  DatabaseMigrationContext,
  DatabaseReadCollections,
  FirestoreDatabase,
  FirestoreDatabaseOptions,
  QueryFilter,
  QueryOptions,
  QueryOrder,
  StoredDocument,
  VersionedDocumentSchema,
} from "./database.js";
export type { MigrationRunResult } from "./types.js";
