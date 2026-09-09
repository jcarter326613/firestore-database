import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import {
    createFirestoreDatabase,
    defineCollection,
    defineDatabaseMigrations,
    migrationChecksum,
} from "../../src/index.js"
import type { DatabaseMigration } from "../../src/index.js"
import { MigrationLeaseUnavailableError } from "../../src/errors.js"
import { runMigrations } from "../../src/runner.js"
import type { MigrationContext } from "../../src/types.js"

const PROJECT_ID = "firestore-database-integration"
const DATABASE_ID = "(default)"
const FIRST_MIGRATION_ID = "202609071200-split-ingredients"
const SECOND_MIGRATION_ID = "202609071300-lease-test"
const THIRD_MIGRATION_ID = "202609071400-resume-test"

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
        "Firestore integration tests require FIRESTORE_EMULATOR_HOST.",
    )
}

const collections = {
    ingredients: defineCollection({
        path: "integration-ingredients",
        schema: z.object({ name: z.string() }).strict(),
    }),
    notes: defineCollection({
        path: "integration-notes",
        schema: z.object({ recipeId: z.string(), text: z.string() }).strict(),
    }),
    recipes: defineCollection({
        path: "integration-recipes",
        schema: z
            .object({
                ingredientIds: z.array(z.string()).optional(),
                migrated: z.boolean().optional(),
                name: z.string(),
                noteCount: z.number().int().optional(),
            })
            .strict(),
    }),
}

const firstMigration: DatabaseMigration<typeof collections> = {
    checksum: migrationChecksum("integration split ingredients v1"),
    description: "Split integration recipe ingredients",
    id: FIRST_MIGRATION_ID,
    async run(migration) {
        await migration.forEachDocument({
            collection: "recipes",
            name: "split-ingredients",
            async change(recipe, { newId, read }) {
                const ingredientId = newId("ingredients")
                const notes = await read.collections.notes.query({
                    where: [
                        { field: "recipeId", operator: "==", value: recipe.id },
                    ],
                })
                return [
                    {
                        collection: "recipes",
                        data: {
                            ...recipe.data,
                            ingredientIds: [
                                ...(recipe.data.ingredientIds ?? []),
                                ingredientId,
                            ],
                            migrated: true,
                            noteCount: notes.length,
                        },
                        id: recipe.id,
                        type: "set",
                    },
                    {
                        collection: "ingredients",
                        data: { name: `${recipe.data.name} ingredient` },
                        id: ingredientId,
                        type: "create",
                    },
                ]
            },
        })
    },
}

const migrations = defineDatabaseMigrations<typeof collections>([
    firstMigration,
])
const database = createFirestoreDatabase({
    collections,
    databaseId: DATABASE_ID,
    migrations,
})

const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID })
const firestore = getFirestore(app, DATABASE_ID)

async function clearCollections(): Promise<void> {
    await Promise.all(
        [
            "integration-ingredients",
            "integration-notes",
            "integration-recipes",
            "__firestore_migrations",
        ].map((path) => firestore.recursiveDelete(firestore.collection(path))),
    )
}

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe.sequential("Firestore emulator integration", () => {
    beforeAll(clearCollections)
    afterAll(clearCollections)

    it("processes markerless documents with related reads and generated child IDs", async () => {
        await firestore
            .collection("integration-recipes")
            .doc("recipe-one")
            .set({
                name: "One",
            })
        await firestore
            .collection("integration-recipes")
            .doc("recipe-two")
            .set({
                name: "Two",
            })
        await firestore.collection("integration-notes").doc("one-note").set({
            recipeId: "recipe-one",
            text: "First",
        })
        await firestore.collection("integration-notes").doc("two-note").set({
            recipeId: "recipe-two",
            text: "Second",
        })

        await expect(database.migrate()).resolves.toMatchObject({
            applied: [FIRST_MIGRATION_ID],
        })

        const recipes = await firestore.collection("integration-recipes").get()
        const ingredients = await firestore
            .collection("integration-ingredients")
            .get()

        expect(recipes.docs).toHaveLength(2)
        expect(ingredients.docs).toHaveLength(2)
        for (const recipe of recipes.docs) {
            expect(recipe.data()).toMatchObject({
                __migrationVersion: FIRST_MIGRATION_ID,
                ingredientIds: [expect.any(String)],
                migrated: true,
                noteCount: 1,
            })
        }
        for (const ingredient of ingredients.docs) {
            expect(ingredient.id).not.toMatch(/^recipe-/)
            expect(ingredient.data()).toMatchObject({
                __migrationVersion: FIRST_MIGRATION_ID,
                name: expect.stringMatching(/ingredient$/),
            })
        }
    })

    it("rejects a second runner while the first holds the lease", async () => {
        const started = deferred()
        const release = deferred()
        const leaseMigrations = [
            {
                checksum: firstMigration.checksum,
                description: firstMigration.description,
                id: FIRST_MIGRATION_ID,
                run: async () => undefined,
            },
            {
                checksum: migrationChecksum("integration lease test v1"),
                description: "Hold the migration lease",
                id: SECOND_MIGRATION_ID,
                async run() {
                    started.resolve()
                    await release.promise
                },
            },
        ]

        const firstRun = runMigrations(firestore, leaseMigrations, {
            leaseDurationMs: 10_000,
        })
        await started.promise

        await expect(
            runMigrations(firestore, leaseMigrations, {
                leaseDurationMs: 10_000,
            }),
        ).rejects.toBeInstanceOf(MigrationLeaseUnavailableError)

        release.resolve()
        await expect(firstRun).resolves.toMatchObject({
            applied: [SECOND_MIGRATION_ID],
        })
    })

    it("resumes a failed document-processing step from its saved cursor", async () => {
        let failOnce = true
        const resumeMigrations = [
            {
                checksum: firstMigration.checksum,
                description: firstMigration.description,
                id: FIRST_MIGRATION_ID,
                run: async () => undefined,
            },
            {
                checksum: migrationChecksum("integration lease test v1"),
                description: "Hold the migration lease",
                id: SECOND_MIGRATION_ID,
                run: async () => undefined,
            },
            {
                checksum: migrationChecksum("integration resume test v1"),
                description: "Verify resumable document processing",
                id: THIRD_MIGRATION_ID,
                async run(migration: MigrationContext) {
                    await migration.forEachDocument({
                        collectionPath: "integration-recipes",
                        name: "resume",
                        pageSize: 1,
                        targetVersion: THIRD_MIGRATION_ID,
                        async change(document) {
                            if (document.id === "recipe-two" && failOnce) {
                                failOnce = false
                                throw new Error("deliberate failure")
                            }
                            return [
                                {
                                    collectionPath: "integration-recipes",
                                    data: document.data(),
                                    documentId: document.id,
                                    type: "set",
                                },
                            ]
                        },
                    })
                },
            },
        ]

        await expect(
            runMigrations(firestore, resumeMigrations),
        ).rejects.toThrow("deliberate failure")
        await expect(
            runMigrations(firestore, resumeMigrations),
        ).resolves.toMatchObject({
            applied: [THIRD_MIGRATION_ID],
        })

        const recipes = await firestore.collection("integration-recipes").get()
        expect(
            recipes.docs.map((document) => document.data().__migrationVersion),
        ).toEqual([THIRD_MIGRATION_ID, THIRD_MIGRATION_ID])
    })
})
