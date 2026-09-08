export class MigrationLeaseUnavailableError extends Error {
  constructor(ownerId: string, expiresAt: Date) {
    super(
      `Firestore migrations are already running under owner "${ownerId}" until ${expiresAt.toISOString()}.`,
    );
    this.name = "MigrationLeaseUnavailableError";
  }
}

export class MigrationLeaseLostError extends Error {
  constructor() {
    super("The Firestore migration lease was lost or expired.");
    this.name = "MigrationLeaseLostError";
  }
}

export class DatabaseMigrationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseMigrationRequiredError";
  }
}
