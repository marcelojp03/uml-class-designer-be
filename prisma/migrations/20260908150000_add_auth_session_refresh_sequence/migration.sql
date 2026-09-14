ALTER TABLE "AuthSession"
    ADD COLUMN "refreshSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_refreshSequence_check" CHECK ("refreshSequence" >= 0);
