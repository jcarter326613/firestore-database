---
"firestore-database": minor
---

Allow collections to use any object-output Zod schema, including discriminated unions. Patches now validate the complete merged document before writing changed fields. Remove the obsolete `VersionedDocumentSchema` export.
