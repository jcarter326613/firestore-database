import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { registryFingerprint } from "../src/registry.js";
import {
  assertMigrationsCurrent,
  migrationStatus,
} from "../src/status.js";

const migrations = [];

function firestoreWithState(data: unknown): Firestore {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: () => data }),
      }),
    }),
  } as unknown as Firestore;
}

describe("migration status", () => {
  it("accepts the exact registry fingerprint with no active migration", async () => {
    const status = await migrationStatus(
      firestoreWithState({
        migrationInProgress: null,
        registryFingerprint: registryFingerprint(migrations),
      }),
      migrations,
    );

    expect(status.current).toBe(true);
  });

  it("rejects an uninitialized database", async () => {
    await expect(
      assertMigrationsCurrent(firestoreWithState(undefined), migrations),
    ).rejects.toThrow("uninitialized database");
  });

  it("rejects a matching registry while migration is active", async () => {
    const status = await migrationStatus(
      firestoreWithState({
        migrationInProgress: "202609071200-example",
        registryFingerprint: registryFingerprint(migrations),
      }),
      migrations,
    );

    expect(status).toMatchObject({
      current: false,
      migrationInProgress: "202609071200-example",
    });
  });
});
