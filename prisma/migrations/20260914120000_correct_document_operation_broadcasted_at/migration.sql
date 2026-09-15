-- Align broadcastedAt with committedAt as TIMESTAMPTZ(3). Non-destructive: type conversion only, no data loss.
-- The explicit USING clause interprets historic timestamp values as UTC, so the
-- resulting instant is identical regardless of the PostgreSQL session timezone.
ALTER TABLE "DocumentOperation"
ALTER COLUMN "broadcastedAt" TYPE TIMESTAMPTZ(3)
USING "broadcastedAt" AT TIME ZONE 'UTC';
