import type { Firestore, Transaction } from "firebase-admin/firestore";

import { DatabaseMigrationRequiredError } from "./errors.js";
import { registryFingerprint } from "./registry.js";
import type {
  FirestoreMigration,
  MigrationStatus,
} from "./types.js";

const DEFAULT_METADATA_COLLECTION = "__firestore_migrations";

export async function migrationStatus(
  firestore: Firestore,
  migrations: readonly FirestoreMigration[],
  metadataCollection = DEFAULT_METADATA_COLLECTION,
): Promise<MigrationStatus> {
  const expectedFingerprint = registryFingerprint(migrations);
  const snapshot = await firestore.collection(metadataCollection).doc("state").get();
  const data = snapshot.data();
  const storedFingerprint =
    typeof data?.registryFingerprint === "string"
      ? data.registryFingerprint
      : undefined;
  const migrationInProgress =
    typeof data?.migrationInProgress === "string"
      ? data.migrationInProgress
      : undefined;

  return {
    current:
      storedFingerprint === expectedFingerprint &&
      data?.migrationInProgress === null,
    expectedFingerprint,
    migrationInProgress,
    storedFingerprint,
  };
}

export async function assertMigrationsCurrent(
  firestore: Firestore,
  migrations: readonly FirestoreMigration[],
  metadataCollection = DEFAULT_METADATA_COLLECTION,
): Promise<void> {
  const status = await migrationStatus(
    firestore,
    migrations,
    metadataCollection,
  );

  if (!status.current) {
    const detail = status.migrationInProgress
      ? `Migration "${status.migrationInProgress}" is in progress or failed.`
      : `Expected registry ${status.expectedFingerprint}, found ${status.storedFingerprint ?? "an uninitialized database"}.`;
    throw new DatabaseMigrationRequiredError(
      `The Firestore database is not at the application migration level. ${detail}`,
    );
  }
}

export async function assertMigrationsCurrentInTransaction(
  transaction: Transaction,
  firestore: Firestore,
  migrations: readonly FirestoreMigration[],
  metadataCollection = DEFAULT_METADATA_COLLECTION,
): Promise<void> {
  const expectedFingerprint = registryFingerprint(migrations);
  const snapshot = await transaction.get(
    firestore.collection(metadataCollection).doc("state"),
  );
  const data = snapshot.data();

  if (
    data?.registryFingerprint !== expectedFingerprint ||
    data?.migrationInProgress !== null
  ) {
    throw new DatabaseMigrationRequiredError(
      "Database writes are blocked until the configured migrations complete.",
    );
  }
}
