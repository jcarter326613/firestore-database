import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

const fakeFirestore = vi.hoisted(() => {
    const documents = new Map<string, Record<string, unknown>>()
    let generatedId = 0
    const reference = (collectionPath: string, id: string) => {
        const key = `${collectionPath}/${id}`
        return {
            data: () => documents.get(key),
            get: async () => ({
                data: () => documents.get(key),
                exists: documents.has(key),
                id,
            }),
            id,
            key,
        }
    }
    const query = (collectionPath: string) => ({
        doc: (id = `generated-${++generatedId}`) =>
            reference(collectionPath, id),
        get: async () => ({
            docs: [...documents.entries()]
                .filter(([key]) => key.startsWith(`${collectionPath}/`))
                .filter(
                    ([key]) =>
                        !key.slice(`${collectionPath}/`.length).includes("/"),
                )
                .map(([key, data]) => ({
                    data: () => data,
                    id: key.slice(`${collectionPath}/`.length),
                })),
        }),
        limit: () => query(collectionPath),
        orderBy: () => query(collectionPath),
        where: () => query(collectionPath),
    })
    const firestore = {
        collection: (collectionPath: string) => query(collectionPath),
        runTransaction: async <Result>(
            operation: (transaction: {
                create: (
                    ref: { key: string },
                    data: Record<string, unknown>,
                ) => void
                delete: (ref: { key: string }) => void
                get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>
                set: (
                    ref: { key: string },
                    data: Record<string, unknown>,
                ) => void
                update: (
                    ref: { key: string },
                    data: Record<string, unknown>,
                ) => void
            }) => Promise<Result>,
        ): Promise<Result> =>
            operation({
                create(ref, data) {
                    if (documents.has(ref.key))
                        throw new Error("already exists")
                    documents.set(ref.key, data)
                },
                delete(ref) {
                    documents.delete(ref.key)
                },
                get: (ref) => ref.get(),
                set(ref, data) {
                    documents.set(ref.key, data)
                },
                update(ref, data) {
                    const existing = documents.get(ref.key)
                    if (!existing) throw new Error("document does not exist")
                    documents.set(ref.key, { ...existing, ...data })
                },
            }),
    }
    return { documents, firestore }
})

vi.mock("firebase-admin/app", () => ({
    applicationDefault: () => ({}),
    getApps: () => [],
    initializeApp: () => ({}),
}))
vi.mock("firebase-admin/firestore", () => ({
    FieldPath: { documentId: () => "__name__" },
    FieldValue: {
        delete: () => ({ type: "delete" }),
        increment: (value: number) => ({ type: "increment", value }),
        serverTimestamp: () => ({ type: "serverTimestamp" }),
    },
    Timestamp: class Timestamp {},
    getFirestore: () => fakeFirestore.firestore,
}))

import {
    createFirestoreDatabase,
    defineCollection,
    DocumentValidationError,
    ReservedDocumentPropertyError,
} from "../src/index.js"

const collections = {
    examples: defineCollection({
        path: "examples",
        schema: z
            .object({ name: z.string().min(1), note: z.string().optional() })
            .strict(),
    }),
}

function database() {
    return createFirestoreDatabase({ collections, databaseId: "test" })
}

describe("Firestore database facade", () => {
    it("creates a document with a Firestore-generated ID", async () => {
        fakeFirestore.documents.clear()

        const created = await database().collections.examples.create({
            name: "Example",
        })

        expect(created).toEqual({
            data: { name: "Example" },
            id: "generated-1",
        })
        expect(
            fakeFirestore.documents.get("examples/generated-1"),
        ).toMatchObject({
            __migrationVersion: "",
            name: "Example",
        })
    })

    it("strips fields an older schema does not know", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/future", {
            __migrationVersion: "202609071200-future-shape",
            futureOnly: "ignored",
            name: "Example",
        })

        await expect(
            database().collections.examples.get("future"),
        ).resolves.toEqual({
            data: { name: "Example" },
            id: "future",
        })
    })

    it("patches only the named fields, preserving others and the migration version", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/legacy", {
            __migrationVersion: "202609071200-old-shape",
            name: "Before",
            note: "keep me",
        })

        await database().collections.examples.patch("legacy", () => ({
            name: "After",
        }))

        expect(fakeFirestore.documents.get("examples/legacy")).toEqual({
            __migrationVersion: "202609071200-old-shape",
            name: "After",
            note: "keep me",
        })
    })

    it("passes the current document to the patch updater", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/current", {
            __migrationVersion: "",
            name: "Before",
        })

        let observed: unknown
        await database().collections.examples.patch("current", (current) => {
            observed = current
            return { note: "added" }
        })

        expect(observed).toEqual({ name: "Before" })
    })

    it("does not write when a patch updater returns no fields", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/unchanged", {
            __migrationVersion: "202609071200-old-shape",
            name: "Before",
        })

        await database().collections.examples.patch("unchanged", () => ({}))

        expect(fakeFirestore.documents.get("examples/unchanged")).toEqual({
            __migrationVersion: "202609071200-old-shape",
            name: "Before",
        })
    })

    it("rejects patching a document that does not exist", async () => {
        fakeFirestore.documents.clear()

        await expect(
            database().collections.examples.patch("missing", () => ({
                name: "Example",
            })),
        ).rejects.toThrow('Document "examples/missing" does not exist.')
    })

    it("validates writes and reserves the hidden migration version", async () => {
        await expect(
            database().collections.examples.create({ name: "" }),
        ).rejects.toBeInstanceOf(DocumentValidationError)
        await expect(
            database().collections.examples.create({
                __migrationVersion: "nope",
                name: "Example",
            } as never),
        ).rejects.toBeInstanceOf(ReservedDocumentPropertyError)
    })

    it("rejects patch fields that do not validate", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/validated", {
            __migrationVersion: "",
            name: "Before",
        })

        await expect(
            database().collections.examples.patch("validated", () => ({
                name: "",
            })),
        ).rejects.toBeInstanceOf(DocumentValidationError)

        expect(fakeFirestore.documents.get("examples/validated")).toEqual({
            __migrationVersion: "",
            name: "Before",
        })
    })

    it("rejects patch fields the schema does not define", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/unknown", {
            __migrationVersion: "",
            name: "Before",
        })

        await expect(
            database().collections.examples.patch(
                "unknown",
                () => ({ futureOnly: "nope" }) as never,
            ),
        ).rejects.toThrow(
            'Field "futureOnly" is not part of the "examples" schema.',
        )
    })

    it("reserves the hidden migration version in a patch", async () => {
        fakeFirestore.documents.clear()
        fakeFirestore.documents.set("examples/reserved", {
            __migrationVersion: "",
            name: "Before",
        })

        await expect(
            database().collections.examples.patch(
                "reserved",
                () => ({ __migrationVersion: "nope" }) as never,
            ),
        ).rejects.toBeInstanceOf(ReservedDocumentPropertyError)
    })
})
