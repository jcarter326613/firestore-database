import { describe, expect, it } from "vitest";

import {
  defineMigrations,
  migrationChecksum,
  registryFingerprint,
} from "../src/registry.js";

const firstMigration = {
  checksum: migrationChecksum("first"),
  description: "First migration",
  id: "001-first",
  run: async () => undefined,
};

describe("migration registry", () => {
  it("produces a stable fingerprint", () => {
    expect(registryFingerprint([firstMigration])).toBe(
      registryFingerprint([{ ...firstMigration }]),
    );
  });

  it("rejects duplicate or unordered IDs", () => {
    expect(() => defineMigrations([firstMigration, firstMigration])).toThrow(
      "strictly increasing",
    );
  });

  it("rejects invalid checksums", () => {
    expect(() =>
      defineMigrations([{ ...firstMigration, checksum: "not-a-checksum" }]),
    ).toThrow("lowercase SHA-256");
  });

  it("rejects Firestore-reserved and oversized IDs", () => {
    expect(() =>
      defineMigrations([{ ...firstMigration, id: "__reserved__" }]),
    ).toThrow("valid Firestore identifier");
    expect(() =>
      defineMigrations([{ ...firstMigration, id: `a${"b".repeat(1_500)}` }]),
    ).toThrow("valid Firestore identifier");
  });
});
