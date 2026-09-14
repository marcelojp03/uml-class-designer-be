CREATE INDEX "DocumentOperation_pending_delivery_idx"
ON "DocumentOperation"("committedAt", "id")
WHERE "broadcastedAt" IS NULL;
