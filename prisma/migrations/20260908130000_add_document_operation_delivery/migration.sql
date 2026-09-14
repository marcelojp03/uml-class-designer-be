ALTER TABLE "DocumentOperation"
ADD COLUMN "broadcastedAt" TIMESTAMP(3);

UPDATE "DocumentOperation"
SET "broadcastedAt" = "committedAt";

CREATE INDEX "DocumentOperation_documentId_broadcastedAt_idx"
ON "DocumentOperation"("documentId", "broadcastedAt");
