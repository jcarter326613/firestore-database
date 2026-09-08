import { createHash } from "node:crypto";

import type { FirestoreMigration } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function validateFirestoreId(id: string, label: string): void {
  if (
    !id ||
    id.includes("/") ||
    id === "." ||
    id === ".." ||
    /^__.*__$/.test(id) ||
    Buffer.byteLength(id, "utf8") > 1_500
  ) {
    throw new Error(`${label} is not a valid Firestore identifier.`);
  }
}

export function defineMigrations(
  migrations: readonly FirestoreMigration[],
): readonly FirestoreMigration[] {
  let previousId: string | undefined;

  for (const migration of migrations) {
    validateFirestoreId(migration.id, `Migration ID "${migration.id}"`);
    if (!ID_PATTERN.test(migration.id)) {
      throw new Error(
        `Migration ID "${migration.id}" must contain only letters, numbers, dots, underscores, and hyphens.`,
      );
    }

    if (previousId !== undefined && migration.id <= previousId) {
      throw new Error(
        `Migration IDs must be unique and strictly increasing: "${migration.id}" follows "${previousId}".`,
      );
    }

    if (!migration.description.trim()) {
      throw new Error(`Migration "${migration.id}" must have a description.`);
    }

    if (!SHA256_PATTERN.test(migration.checksum)) {
      throw new Error(
        `Migration "${migration.id}" checksum must be a lowercase SHA-256 digest.`,
      );
    }

    previousId = migration.id;
  }

  return Object.freeze([...migrations]);
}

export function migrationChecksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function registryFingerprint(
  migrations: readonly FirestoreMigration[],
): string {
  const validated = defineMigrations(migrations);
  const canonicalRegistry = validated
    .map(({ checksum, id }) => `${id}:${checksum}`)
    .join("\n");

  return migrationChecksum(canonicalRegistry);
}
