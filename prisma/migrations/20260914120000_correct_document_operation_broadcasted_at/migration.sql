-- Align broadcastedAt with committedAt as TIMESTAMPTZ(3). Non-destructive: type conversion only, no data loss.
ALTER TABLE "DocumentOperation"
ALTER COLUMN "broadcastedAt" TYPE TIMESTAMPTZ(3);
