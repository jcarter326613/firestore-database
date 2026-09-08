import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type Transaction,
  type WhereFilterOp,
} from "firebase-admin/firestore";
import { z } from "zod";

import { defineMigrations } from "./registry.js";
import { runMigrations } from "./runner.js";
import type {
  DocumentOperation,
  FirestoreMigration,
  MigrationRunResult,
} from "./types.js";

const DOCUMENT_VERSION = "__migrationVersion";

export class DocumentValidationError extends Error {
  constructor(
    readonly collectionPath: string,
    readonly documentId: string,
    readonly cause: z.ZodError,
  ) {
    super(
      `Document "${collectionPath}/${documentId}" does not match its schema: ${cause.message}`,
    );
    this.name = "DocumentValidationError";
  }
}

export class ReservedDocumentPropertyError extends Error {
  constructor() {
    super(`"${DOCUMENT_VERSION}" is managed by the Firestore database facade.`);
    this.name = "ReservedDocumentPropertyError";
  }
}

export interface VersionedDocumentSchema<Output extends object = object>
  extends z.ZodType<Output> {
  readonly shape: Record<string, unknown>;
  strip(): z.ZodType<Output>;
}

export interface CollectionDefinition<
  Schema extends VersionedDocumentSchema = VersionedDocumentSchema,
> {
  path: string;
  schema: Schema;
}

export function defineCollection<Schema extends VersionedDocumentSchema>(
  definition: CollectionDefinition<Schema>,
): CollectionDefinition<Schema> {
  if (!definition.path || definition.path.includes("/")) {
    throw new Error("Collection paths must be a single, non-empty collection ID.");
  }
  if (DOCUMENT_VERSION in definition.schema.shape) {
    throw new ReservedDocumentPropertyError();
  }
  return Object.freeze({ ...definition });
}

type CollectionDefinitions = Record<string, CollectionDefinition>;
type DocumentFor<Definition extends CollectionDefinition> = z.output<
  Definition["schema"]
> extends object
  ? z.output<Definition["schema"]>
  : never;

export type CollectionDocument<Definition extends CollectionDefinition> =
  DocumentFor<Definition>;

export interface StoredDocument<T> {
  data: T;
  id: string;
}

type FieldName<T> = Extract<keyof T, string>;

export type QueryFilter<T> = {
  [Field in FieldName<T>]: {
    field: Field;
    operator: WhereFilterOp;
    value: T[Field];
  };
}[FieldName<T>];

export interface QueryOrder<T> {
  direction?: "asc" | "desc";
  field: FieldName<T>;
}

export interface QueryOptions<T> {
  limit?: number;
  orderBy?: readonly QueryOrder<T>[];
  where?: readonly QueryFilter<T>[];
}

export interface DatabaseCollection<T extends object> {
  create(data: T): Promise<StoredDocument<T>>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<StoredDocument<T> | undefined>;
  query(options?: QueryOptions<T>): Promise<StoredDocument<T>[]>;
  set(id: string, data: T): Promise<void>;
  update(id: string, updater: (current: T) => T): Promise<T>;
}

export type DatabaseCollections<Definitions extends CollectionDefinitions> = {
  [Name in keyof Definitions]: DatabaseCollection<DocumentFor<Definitions[Name]>>;
};

export type DatabaseReadCollections<Definitions extends CollectionDefinitions> = {
  [Name in keyof Definitions]: Pick<
    DatabaseCollection<DocumentFor<Definitions[Name]>>,
    "get" | "query"
  >;
};

export type DatabaseDocumentOperation<Definitions extends CollectionDefinitions> = {
  [Name in keyof Definitions & string]:
    | { collection: Name; id: string; type: "delete" }
    | {
        collection: Name;
        data: DocumentFor<Definitions[Name]>;
        id: string;
        type: "create" | "set";
      };
}[keyof Definitions & string];

export interface DatabaseMigrationContext<Definitions extends CollectionDefinitions> {
  forEachDocument<Name extends keyof Definitions & string>(options: {
    collection: Name;
    name: string;
    change: (
      document: StoredDocument<DocumentFor<Definitions[Name]>>,
      context: {
        newId<Collection extends keyof Definitions & string>(collection: Collection): string;
        read: { collections: DatabaseReadCollections<Definitions> };
      },
    ) =>
      | readonly DatabaseDocumentOperation<Definitions>[]
      | Promise<readonly DatabaseDocumentOperation<Definitions>[]>;
  }): Promise<{ changed: number; processed: number }>;
}

export interface DatabaseMigration<Definitions extends CollectionDefinitions> {
  checksum: string;
  description: string;
  id: string;
  run(context: DatabaseMigrationContext<Definitions>): Promise<void>;
}

export function defineDatabaseMigrations<Definitions extends CollectionDefinitions>(
  migrations: readonly DatabaseMigration<Definitions>[],
): readonly DatabaseMigration<Definitions>[] {
  defineMigrations(
    migrations.map(({ checksum, description, id }) => ({
      checksum,
      description,
      id,
      run: async () => undefined,
    })),
  );
  return Object.freeze([...migrations]);
}

export interface FirestoreDatabaseOptions<Definitions extends CollectionDefinitions> {
  collections: Definitions;
  databaseId: string;
  migrations?: readonly DatabaseMigration<Definitions>[];
}

export interface FirestoreDatabase<Definitions extends CollectionDefinitions> {
  collections: DatabaseCollections<Definitions>;
  migrate(): Promise<MigrationRunResult>;
  transaction<Result>(
    operation: (database: { collections: DatabaseCollections<Definitions> }) => Promise<Result>,
  ): Promise<Result>;
}

const databases = new Map<
  string,
  { configurationKey: string; database: FirestoreDatabase<CollectionDefinitions> }
>();

function managedFirestore(databaseId: string): Firestore {
  if (!databaseId) {
    throw new Error("databaseId must be configured for Firestore access.");
  }
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
  return getFirestore(app, databaseId);
}

function parse<T extends object>(
  schema: z.ZodType<T>,
  data: unknown,
  path: string,
  id: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DocumentValidationError(path, id, result.error);
  }
  return result.data;
}

function visible(data: DocumentData): DocumentData {
  const { [DOCUMENT_VERSION]: _version, ...document } = data;
  return document;
}

function buildQuery<T extends object>(
  firestore: Firestore,
  path: string,
  options: QueryOptions<T> | undefined,
): Query<DocumentData> {
  let query: Query<DocumentData> = firestore.collection(path);
  for (const filter of options?.where ?? []) {
    query = query.where(filter.field, filter.operator, filter.value);
  }
  for (const order of options?.orderBy ?? []) {
    query = query.orderBy(order.field, order.direction);
  }
  if (options?.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("Query limits must be positive integers.");
    }
    query = query.limit(options.limit);
  }
  return query;
}

function collectionFacade<T extends object>(
  firestore: Firestore,
  definition: CollectionDefinition<VersionedDocumentSchema<T>>,
  currentVersion: string,
  transaction?: Transaction,
): DatabaseCollection<T> {
  const collection = firestore.collection(definition.path);
  const parseRead = (snapshot: QueryDocumentSnapshot<DocumentData>): StoredDocument<T> => ({
    data: parse(definition.schema.strip(), visible(snapshot.data()), definition.path, snapshot.id),
    id: snapshot.id,
  });
  const parseWrite = (id: string, data: T): T => {
    if (DOCUMENT_VERSION in data) {
      throw new ReservedDocumentPropertyError();
    }
    return parse(definition.schema, data, definition.path, id);
  };
  const withTransaction = <Result>(
    operation: (activeTransaction: Transaction) => Promise<Result>,
  ): Promise<Result> =>
    transaction === undefined ? firestore.runTransaction(operation) : operation(transaction);
  const stored = (data: T, version: string): DocumentData => ({
    ...data,
    [DOCUMENT_VERSION]: version,
  });

  return {
    async create(data) {
      const id = collection.doc().id;
      const validated = parseWrite(id, data);
      await withTransaction(async (activeTransaction) => {
        activeTransaction.create(collection.doc(id), stored(validated, currentVersion));
      });
      return { data: validated, id };
    },
    async delete(id) {
      await withTransaction(async (activeTransaction) => {
        activeTransaction.delete(collection.doc(id));
      });
    },
    async get(id) {
      const snapshot =
        transaction === undefined
          ? await collection.doc(id).get()
          : await transaction.get(collection.doc(id));
      return snapshot.exists
        ? parseRead(snapshot as QueryDocumentSnapshot<DocumentData>)
        : undefined;
    },
    async query(options) {
      const query = buildQuery(firestore, definition.path, options);
      const snapshot = transaction === undefined ? await query.get() : await transaction.get(query);
      return snapshot.docs.map(parseRead);
    },
    async set(id, data) {
      const validated = parseWrite(id, data);
      await withTransaction(async (activeTransaction) => {
        const snapshot = await activeTransaction.get(collection.doc(id));
        const version = snapshot.exists
          ? String((snapshot.data() as DocumentData)[DOCUMENT_VERSION] ?? "")
          : currentVersion;
        activeTransaction.set(collection.doc(id), stored(validated, version));
      });
    },
    async update(id, updater) {
      return withTransaction(async (activeTransaction) => {
        const reference = collection.doc(id);
        const snapshot = await activeTransaction.get(reference);
        if (!snapshot.exists) {
          throw new Error(`Document "${definition.path}/${id}" does not exist.`);
        }
        const updated = parseWrite(
          id,
          updater(parseRead(snapshot as QueryDocumentSnapshot<DocumentData>).data),
        );
        const version = String((snapshot.data() as DocumentData)[DOCUMENT_VERSION] ?? "");
        activeTransaction.set(reference, stored(updated, version));
        return updated;
      });
    },
  };
}

export function createFirestoreDatabase<Definitions extends CollectionDefinitions>(
  options: FirestoreDatabaseOptions<Definitions>,
): FirestoreDatabase<Definitions> {
  const migrations = defineDatabaseMigrations(options.migrations ?? []);
  const configurationKey = JSON.stringify({
    collections: Object.entries(options.collections).map(([name, definition]) => [
      name,
      definition.path,
    ]),
    migrations: migrations.map(({ checksum, id }) => [id, checksum]),
  });
  const existing = databases.get(options.databaseId);
  if (existing) {
    if (existing.configurationKey !== configurationKey) {
      throw new Error(
        `A different Firestore database facade is already configured for "${options.databaseId}".`,
      );
    }
    return existing.database as unknown as FirestoreDatabase<Definitions>;
  }

  const firestore = managedFirestore(options.databaseId);
  const currentVersion = migrations.at(-1)?.id ?? "";
  const collectionsFor = (transaction?: Transaction): DatabaseCollections<Definitions> =>
    Object.fromEntries(
      Object.entries(options.collections).map(([name, definition]) => [
        name,
        collectionFacade(
          firestore,
          definition as CollectionDefinition<VersionedDocumentSchema<object>>,
          currentVersion,
          transaction,
        ),
      ]),
    ) as unknown as DatabaseCollections<Definitions>;

  const internalMigrations: readonly FirestoreMigration[] = migrations.map((migration) => ({
    checksum: migration.checksum,
    description: migration.description,
    id: migration.id,
    async run(context) {
      await migration.run({
        async forEachDocument(processing) {
          const definition = options.collections[processing.collection];
          if (!definition) {
            throw new Error(
              `Migration "${migration.id}" refers to an unknown collection "${processing.collection}".`,
            );
          }
          return context.forEachDocument({
            collectionPath: definition.path,
            name: processing.name,
            targetVersion: migration.id,
            async change(snapshot, transaction, activeFirestore) {
              const document = {
                data: parse(
                  definition.schema.strip(),
                  visible(snapshot.data()),
                  definition.path,
                  snapshot.id,
                ),
                id: snapshot.id,
              } as StoredDocument<DocumentFor<Definitions[typeof processing.collection]>>;
              const operations = await processing.change(document, {
                newId(name) {
                  const target = options.collections[name];
                  if (!target) {
                    throw new Error(`Migration "${migration.id}" refers to an unknown collection "${name}".`);
                  }
                  return activeFirestore.collection(target.path).doc().id;
                },
                read: {
                  collections: collectionsFor(transaction) as DatabaseReadCollections<Definitions>,
                },
              });
              return operations.map((operation): DocumentOperation => {
                const target = options.collections[operation.collection];
                if (!target) {
                  throw new Error(
                    `Migration "${migration.id}" refers to an unknown collection "${operation.collection}".`,
                  );
                }
                if (operation.type === "delete") {
                  return {
                    collectionPath: target.path,
                    documentId: operation.id,
                    type: "delete",
                  };
                }
                const data = parse(target.schema, operation.data, target.path, operation.id);
                return {
                  collectionPath: target.path,
                  data: { ...data },
                  documentId: operation.id,
                  type: operation.type,
                };
              });
            },
          });
        },
      });
    },
  }));

  const database: FirestoreDatabase<Definitions> = {
    collections: collectionsFor(),
    migrate: () => runMigrations(firestore, internalMigrations),
    transaction: (operation) =>
      firestore.runTransaction((transaction) => operation({ collections: collectionsFor(transaction) })),
  };
  databases.set(options.databaseId, {
    configurationKey,
    database: database as unknown as FirestoreDatabase<CollectionDefinitions>,
  });
  return database;
}
