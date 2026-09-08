import type {
  DocumentData,
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";

export interface DocumentOperation {
  collectionPath: string;
  data?: DocumentData;
  documentId: string;
  type: "create" | "delete" | "set";
}

export interface ForEachDocumentOptions {
  collectionPath: string;
  name: string;
  pageSize?: number;
  targetVersion: string;
  change: (
    snapshot: QueryDocumentSnapshot,
    transaction: Transaction,
    firestore: Firestore,
  ) => Promise<readonly DocumentOperation[]>;
}

export interface DocumentProcessingResult {
  changed: number;
  processed: number;
}

export interface MigrationContext {
  forEachDocument(options: ForEachDocumentOptions): Promise<DocumentProcessingResult>;
}

export interface FirestoreMigration {
  /** Stable sortable identifier, conventionally `YYYYMMDDHHMM-description`. */
  id: string;
  description: string;
  /** SHA-256 of the immutable migration source or its canonical contents. */
  checksum: string;
  run(context: MigrationContext): Promise<void>;
}

export interface MigrationRunnerOptions {
  leaseDurationMs?: number;
  metadataCollection?: string;
  ownerId?: string;
}

export interface MigrationRunResult {
  applied: string[];
  registryFingerprint: string;
}

export interface MigrationStatus {
  current: boolean;
  expectedFingerprint: string;
  migrationInProgress?: string;
  storedFingerprint?: string;
}
