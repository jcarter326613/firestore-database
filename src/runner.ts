import { randomUUID } from "node:crypto";

import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  MigrationLeaseLostError,
  MigrationLeaseUnavailableError,
} from "./errors.js";
import {
  defineMigrations,
  registryFingerprint,
  validateFirestoreId,
} from "./registry.js";
import type {
  DocumentOperation,
  DocumentProcessingResult,
  ForEachDocumentOptions,
  FirestoreMigration,
  MigrationContext,
  MigrationRunnerOptions,
  MigrationRunResult,
} from "./types.js";

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_METADATA_COLLECTION = "__firestore_migrations";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 400;
const MAX_TRANSACTION_WRITES = 500;
const LEDGER_FORMAT_VERSION = 1;
const DOCUMENT_VERSION = "__migrationVersion";

interface Lease {
  fencingToken: number;
  ownerId: string;
}

interface RunnerConfiguration {
  leaseDurationMs: number;
  metadataCollection: string;
  ownerId: string;
}

interface LedgerDocument {
  checksum?: unknown;
  status?: unknown;
}

function configuration(options: MigrationRunnerOptions): RunnerConfiguration {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const metadataCollection =
    options.metadataCollection ?? DEFAULT_METADATA_COLLECTION;

  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 10_000) {
    throw new Error("leaseDurationMs must be an integer of at least 10000.");
  }

  validateFirestoreId(metadataCollection, "metadataCollection");

  return {
    leaseDurationMs,
    metadataCollection,
    ownerId: options.ownerId ?? randomUUID(),
  };
}

function refs(firestore: Firestore, metadataCollection: string) {
  const metadata = firestore.collection(metadataCollection);
  const state = metadata.doc("state");

  return {
    lease: metadata.doc("lease"),
    ledger: state.collection("ledger"),
    state,
  };
}

function leaseExpiration(leaseDurationMs: number): Timestamp {
  return Timestamp.fromMillis(Date.now() + leaseDurationMs);
}

async function acquireLease(
  firestore: Firestore,
  leaseReference: DocumentReference,
  config: RunnerConfiguration,
): Promise<Lease> {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(leaseReference);
    const existing = snapshot.data();
    const existingExpiration = existing?.expiresAt;

    if (
      existingExpiration instanceof Timestamp &&
      existingExpiration.toMillis() > Date.now()
    ) {
      throw new MigrationLeaseUnavailableError(
        String(existing?.ownerId),
        existingExpiration.toDate(),
      );
    }

    const fencingToken =
      typeof existing?.fencingToken === "number"
        ? existing.fencingToken + 1
        : 1;

    transaction.set(leaseReference, {
      acquiredAt: FieldValue.serverTimestamp(),
      expiresAt: leaseExpiration(config.leaseDurationMs),
      fencingToken,
      ownerId: config.ownerId,
    });

    return { fencingToken, ownerId: config.ownerId };
  });
}

function assertLeaseData(
  data: DocumentData | undefined,
  lease: Lease,
): void {
  if (
    data?.ownerId !== lease.ownerId ||
    data.fencingToken !== lease.fencingToken ||
    !(data.expiresAt instanceof Timestamp) ||
    data.expiresAt.toMillis() <= Date.now()
  ) {
    throw new MigrationLeaseLostError();
  }
}

async function renewLease(
  firestore: Firestore,
  leaseReference: DocumentReference,
  lease: Lease,
  leaseDurationMs: number,
): Promise<void> {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(leaseReference);
    assertLeaseData(snapshot.data(), lease);
    transaction.update(leaseReference, {
      expiresAt: leaseExpiration(leaseDurationMs),
      renewedAt: FieldValue.serverTimestamp(),
    });
  });
}

function startHeartbeat(
  firestore: Firestore,
  leaseReference: DocumentReference,
  lease: Lease,
  leaseDurationMs: number,
): { assertHealthy(): void; stop(): Promise<void> } {
  let stopped = false;
  let error: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRenewal: Promise<void> | undefined;

  const schedule = () => {
    timer = setTimeout(() => {
      activeRenewal = renewLease(
        firestore,
        leaseReference,
        lease,
        leaseDurationMs,
      )
        .catch((renewalError: unknown) => {
          error = renewalError;
        })
        .finally(() => {
          activeRenewal = undefined;
          if (!stopped && error === undefined) {
            schedule();
          }
        });
    }, Math.floor(leaseDurationMs / 3));
    timer.unref?.();
  };

  schedule();

  return {
    assertHealthy() {
      if (error !== undefined) {
        throw error;
      }
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await activeRenewal;
      if (error !== undefined) {
        throw error;
      }
    },
  };
}

async function releaseLease(
  firestore: Firestore,
  leaseReference: DocumentReference,
  lease: Lease,
): Promise<void> {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(leaseReference);
    const data = snapshot.data();

    if (
      data?.ownerId === lease.ownerId &&
      data.fencingToken === lease.fencingToken
    ) {
      transaction.update(leaseReference, {
        expiresAt: Timestamp.fromMillis(0),
        ownerId: null,
        releasedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

function validateName(name: string): void {
  validateFirestoreId(name, `Migration document-processing name "${name}"`);
}

function isTransactionSizeError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";

  return (
    candidate?.code === 8 ||
    /10\s*mib|request.*too large|transaction.*too large|maximum.*500|too many.*writes|write.*limit/i.test(
      message,
    )
  );
}

function migrationContext(
  firestore: Firestore,
  migration: FirestoreMigration,
  leaseReference: DocumentReference,
  ledgerReference: DocumentReference,
  lease: Lease,
  leaseDurationMs: number,
  assertHeartbeat: () => void,
): MigrationContext {
  const assertRunningMigration = (
    data: DocumentData | undefined,
  ) => {
    if (data?.status !== "running" || data.checksum !== migration.checksum) {
      throw new Error(`Migration "${migration.id}" is not running.`);
    }
  };

  return {
    async forEachDocument(
      options: ForEachDocumentOptions,
    ): Promise<DocumentProcessingResult> {
      validateName(options.name);
      const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

      if (
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > MAX_PAGE_SIZE
      ) {
        throw new Error(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
      }

      if (!options.collectionPath) {
        throw new Error("collectionPath must be non-empty.");
      }

      const stepReference = ledgerReference.collection("steps").doc(options.name);
      let effectivePageSize = pageSize;
      let totalChanged = 0;
      let totalProcessed = 0;

      for (;;) {
        assertHeartbeat();
        let page: { changed: number; complete: boolean; processed: number };
        try {
          page = await firestore.runTransaction(async (transaction) => {
            const [leaseSnapshot, ledgerSnapshot, stepSnapshot] =
              await transaction.getAll(
                leaseReference,
                ledgerReference,
                stepReference,
              );
            assertLeaseData(leaseSnapshot.data(), lease);
            assertRunningMigration(ledgerSnapshot.data());

            const stepData = stepSnapshot.data();
            const continuingStep = stepData?.checksum === migration.checksum;
            if (continuingStep && stepData.status === "completed") {
              return { changed: 0, complete: true, processed: 0 };
            }

            let query = firestore
              .collection(options.collectionPath)
              .orderBy(FieldPath.documentId())
              .limit(effectivePageSize);
            if (continuingStep && typeof stepData.cursor === "string") {
              query = query.startAfter(stepData.cursor);
            }

            const querySnapshot = await transaction.get(query);
            let changed = 0;
            const changes: {
              document: QueryDocumentSnapshot;
              operations: readonly DocumentOperation[];
            }[] = [];

            for (const document of querySnapshot.docs) {
              const version = document.data()[DOCUMENT_VERSION];
              if (
                typeof version === "string" &&
                version >= options.targetVersion
              ) {
                continue;
              }
              const operations = await options.change(document, transaction, firestore);
              changes.push({ document, operations });
            }

            // The processing record and lease renewal consume two writes.
            let writeCount = 2;
            for (const { document, operations } of changes) {
              let sourceDeleted = false;
              writeCount += operations.length + 1;
              if (writeCount > MAX_TRANSACTION_WRITES) {
                throw new Error(
                  `Migration page exceeds Firestore's ${MAX_TRANSACTION_WRITES}-write transaction limit.`,
                );
              }
              for (const operation of operations) {
                const reference = firestore
                  .collection(operation.collectionPath)
                  .doc(operation.documentId);
                if (operation.type === "delete") {
                  transaction.delete(
                    reference,
                  );
                  sourceDeleted ||= reference.path === document.ref.path;
                } else if (operation.type === "create") {
                  transaction.create(reference, {
                    ...operation.data!,
                    [DOCUMENT_VERSION]: options.targetVersion,
                  });
                } else {
                  transaction.set(reference, {
                    ...operation.data!,
                    [DOCUMENT_VERSION]: options.targetVersion,
                  });
                }
              }
              if (!sourceDeleted) {
                transaction.set(
                  document.ref,
                  { [DOCUMENT_VERSION]: options.targetVersion },
                  { merge: true },
                );
              }
              changed += operations.length;
            }

            const complete = querySnapshot.empty;
            const cursor = querySnapshot.docs.at(-1)?.id;
            const previousChanged =
              continuingStep && typeof stepData?.changed === "number"
                ? stepData.changed
                : 0;
            const previousProcessed =
              continuingStep && typeof stepData?.processed === "number"
                ? stepData.processed
                : 0;
            transaction.set(
              stepReference,
              {
                changed: previousChanged + changed,
                checksum: migration.checksum,
                cursor:
                  cursor ??
                  (continuingStep ? stepData?.cursor : undefined) ??
                  null,
                processed: previousProcessed + querySnapshot.size,
                status: complete ? "completed" : "running",
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
            transaction.update(leaseReference, {
              expiresAt: leaseExpiration(leaseDurationMs),
              renewedAt: FieldValue.serverTimestamp(),
            });

            return {
              changed,
              complete,
              processed: querySnapshot.size,
            };
          });
        } catch (error) {
          if (effectivePageSize > 1 && isTransactionSizeError(error)) {
            effectivePageSize = Math.max(1, Math.floor(effectivePageSize / 2));
            continue;
          }
          throw error;
        }

        totalChanged += page.changed;
        totalProcessed += page.processed;
        if (page.complete) {
          return { changed: totalChanged, processed: totalProcessed };
        }
      }
    },
  };
}

async function markFailure(
  firestore: Firestore,
  leaseReference: DocumentReference,
  ledgerReference: DocumentReference,
  lease: Lease,
  error: unknown,
): Promise<void> {
  await firestore.runTransaction(async (transaction) => {
    const leaseSnapshot = await transaction.get(leaseReference);
    assertLeaseData(leaseSnapshot.data(), lease);
    transaction.set(
      ledgerReference,
      {
        error: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
        status: "failed",
      },
      { merge: true },
    );
  });
}

export async function runMigrations(
  firestore: Firestore,
  migrations: readonly FirestoreMigration[],
  options: MigrationRunnerOptions = {},
): Promise<MigrationRunResult> {
  const registry = defineMigrations(migrations);
  const fingerprint = registryFingerprint(registry);
  const config = configuration(options);
  const references = refs(firestore, config.metadataCollection);
  const lease = await acquireLease(firestore, references.lease, config);
  const heartbeat = startHeartbeat(
    firestore,
    references.lease,
    lease,
    config.leaseDurationMs,
  );
  const applied: string[] = [];

  try {
    const ledgerSnapshot = await references.ledger.orderBy(FieldPath.documentId()).get();
    const ledger = new Map(
      ledgerSnapshot.docs.map((document) => [
        document.id,
        document.data() as LedgerDocument,
      ]),
    );

    for (const [id, entry] of ledger) {
      const migration = registry.find((candidate) => candidate.id === id);
      if (!migration) {
        throw new Error(
          `Applied migration "${id}" is absent from the current registry.`,
        );
      }
      if (
        entry.status === "completed" &&
        entry.checksum !== migration.checksum
      ) {
        throw new Error(`Applied migration "${id}" has been modified.`);
      }
    }

    let foundPending = false;
    for (const migration of registry) {
      const entry = ledger.get(migration.id);
      if (entry?.status === "completed") {
        if (foundPending) {
          throw new Error(
            `Migration "${migration.id}" completed after an incomplete migration.`,
          );
        }
      } else {
        foundPending = true;
      }
    }

    const pending = registry.filter(
      (migration) => ledger.get(migration.id)?.status !== "completed",
    );

    await firestore.runTransaction(async (transaction) => {
      const leaseSnapshot = await transaction.get(references.lease);
      assertLeaseData(leaseSnapshot.data(), lease);
      transaction.set(
        references.state,
        {
          formatVersion: LEDGER_FORMAT_VERSION,
          migrationInProgress: pending[0]?.id ?? null,
          targetRegistryFingerprint: fingerprint,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    for (const migration of pending) {
      heartbeat.assertHealthy();
      const ledgerReference = references.ledger.doc(migration.id);

      await firestore.runTransaction(async (transaction) => {
        const leaseSnapshot = await transaction.get(references.lease);
        assertLeaseData(leaseSnapshot.data(), lease);
        transaction.set(
          ledgerReference,
          {
            attempts: FieldValue.increment(1),
            checksum: migration.checksum,
            description: migration.description,
            error: FieldValue.delete(),
            startedAt: FieldValue.serverTimestamp(),
            status: "running",
          },
          { merge: true },
        );
        transaction.set(
          references.state,
          {
            migrationInProgress: migration.id,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });

      try {
        await migration.run(
          migrationContext(
            firestore,
            migration,
            references.lease,
            ledgerReference,
            lease,
            config.leaseDurationMs,
            heartbeat.assertHealthy,
          ),
        );
        heartbeat.assertHealthy();

        await firestore.runTransaction(async (transaction) => {
          const leaseSnapshot = await transaction.get(references.lease);
          assertLeaseData(leaseSnapshot.data(), lease);
          transaction.set(
            ledgerReference,
            {
              completedAt: FieldValue.serverTimestamp(),
              error: FieldValue.delete(),
              status: "completed",
            },
            { merge: true },
          );
          transaction.set(
            references.state,
            {
              latestMigrationId: migration.id,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        });
        applied.push(migration.id);
      } catch (error) {
        await markFailure(
          firestore,
          references.lease,
          ledgerReference,
          lease,
          error,
        ).catch(() => undefined);
        throw error;
      }
    }

    await firestore.runTransaction(async (transaction) => {
      const leaseSnapshot = await transaction.get(references.lease);
      assertLeaseData(leaseSnapshot.data(), lease);
      transaction.set(
        references.state,
        {
          formatVersion: LEDGER_FORMAT_VERSION,
          latestMigrationId: registry.at(-1)?.id ?? null,
          migrationInProgress: null,
          registryFingerprint: fingerprint,
          targetRegistryFingerprint: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return { applied, registryFingerprint: fingerprint };
  } finally {
    await heartbeat.stop().catch(() => undefined);
    await releaseLease(firestore, references.lease, lease).catch(() => undefined);
  }
}
