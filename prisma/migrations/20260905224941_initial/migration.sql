-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'EDITOR');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "User_email_normalized_check" CHECK ("email" = lower(btrim("email"))),
    CONSTRAINT "User_display_name_length_check" CHECK (char_length(btrim("displayName")) BETWEEN 1 AND 100),
    CONSTRAINT "User_password_hash_check" CHECK (char_length("passwordHash") > 20)
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthSession_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AuthSession_expiry_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "ConsumedRefreshToken" (
    "tokenHash" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumedRefreshToken_pkey" PRIMARY KEY ("tokenHash"),
    CONSTRAINT "ConsumedRefreshToken_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Project_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 160),
    CONSTRAINT "Project_description_length_check" CHECK ("description" IS NULL OR char_length("description") <= 2000)
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "UmlDocument" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalModel" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UmlDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UmlDocument_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 160),
    CONSTRAINT "UmlDocument_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "UmlDocument_schema_version_check" CHECK ("schemaVersion" = '0.1.0')
);

-- CreateTable
CREATE TABLE "DocumentRevision" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "canonicalModel" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentRevision_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "DocumentRevision_schema_version_check" CHECK ("schemaVersion" = '0.1.0')
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ConsumedRefreshToken_sessionId_idx" ON "ConsumedRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- A project can never have more than one owner membership.
CREATE UNIQUE INDEX "ProjectMember_one_owner_per_project" ON "ProjectMember"("projectId") WHERE "role" = 'OWNER';

-- CreateIndex
CREATE INDEX "UmlDocument_projectId_idx" ON "UmlDocument"("projectId");

-- CreateIndex
CREATE INDEX "UmlDocument_createdById_idx" ON "UmlDocument"("createdById");

-- CreateIndex
CREATE INDEX "UmlDocument_updatedById_idx" ON "UmlDocument"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "UmlDocument_projectId_name_key" ON "UmlDocument"("projectId", "name");

-- CreateIndex
CREATE INDEX "DocumentRevision_authorId_idx" ON "DocumentRevision"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRevision_documentId_revision_key" ON "DocumentRevision"("documentId", "revision");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumedRefreshToken" ADD CONSTRAINT "ConsumedRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UmlDocument" ADD CONSTRAINT "UmlDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UmlDocument" ADD CONSTRAINT "UmlDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UmlDocument" ADD CONSTRAINT "UmlDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "UmlDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one OWNER membership must match Project.ownerId at transaction commit.
CREATE FUNCTION "assert_project_owner_membership"() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "ProjectMember"
        WHERE "projectId" = NEW."id"
          AND "userId" = NEW."ownerId"
          AND "role" = 'OWNER'
    ) THEN
        RAISE EXCEPTION 'project must have one matching OWNER membership' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Project_owner_membership_check"
AFTER INSERT OR UPDATE ON "Project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_project_owner_membership"();

CREATE FUNCTION "assert_member_owner_invariant"() RETURNS trigger AS $$
DECLARE
    affected_project_id UUID;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        affected_project_id := OLD."projectId";
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = affected_project_id)
           AND NOT EXISTS (
               SELECT 1
               FROM "Project" p
               JOIN "ProjectMember" m
                 ON m."projectId" = p."id"
                AND m."userId" = p."ownerId"
                AND m."role" = 'OWNER'
               WHERE p."id" = affected_project_id
           ) THEN
            RAISE EXCEPTION 'project OWNER membership cannot be removed, moved or degraded' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        affected_project_id := NEW."projectId";
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = affected_project_id)
           AND NOT EXISTS (
               SELECT 1
               FROM "Project" p
               JOIN "ProjectMember" m
                 ON m."projectId" = p."id"
                AND m."userId" = p."ownerId"
                AND m."role" = 'OWNER'
               WHERE p."id" = affected_project_id
           ) THEN
            RAISE EXCEPTION 'project must retain its matching OWNER membership' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ProjectMember_owner_invariant_check"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectMember"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_member_owner_invariant"();
