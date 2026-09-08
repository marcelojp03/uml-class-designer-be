CREATE TABLE "DocumentOperation" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "resultingRevision" INTEGER NOT NULL,
    "command" JSONB NOT NULL,
    "commandFingerprint" CHAR(64) NOT NULL,
    "committedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentOperation_baseRevision_check" CHECK ("baseRevision" >= 0),
    CONSTRAINT "DocumentOperation_resultingRevision_check" CHECK ("resultingRevision" = "baseRevision" + 1)
);

CREATE UNIQUE INDEX "DocumentOperation_documentId_operationId_key"
    ON "DocumentOperation"("documentId", "operationId");

CREATE INDEX "DocumentOperation_documentId_resultingRevision_idx"
    ON "DocumentOperation"("documentId", "resultingRevision");

CREATE INDEX "DocumentOperation_documentId_baseRevision_idx"
    ON "DocumentOperation"("documentId", "baseRevision");

CREATE INDEX "DocumentOperation_actorId_idx"
    ON "DocumentOperation"("actorId");

ALTER TABLE "DocumentOperation"
    ADD CONSTRAINT "DocumentOperation_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "UmlDocument"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentOperation"
    ADD CONSTRAINT "DocumentOperation_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
