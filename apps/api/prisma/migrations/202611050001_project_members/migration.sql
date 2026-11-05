CREATE TABLE "terms_acceptances" (
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "version" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("user_id", "version")
);
CREATE TABLE "project_members" (
  "project_id" UUID NOT NULL REFERENCES "projects"("id"),
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "invitation_id" UUID REFERENCES "invitations"("id"),
  "terms_version" TEXT NOT NULL,
  "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("project_id", "user_id")
);
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");
ALTER TABLE "stories" ADD COLUMN "included" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "first_copy_orders" ALTER COLUMN "narrator_confirmation_id" DROP NOT NULL, ALTER COLUMN "initiator_confirmation_id" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "narrator_confirmation_id" DROP NOT NULL, ALTER COLUMN "initiator_confirmation_id" DROP NOT NULL;
ALTER TABLE "first_copy_orders" ADD COLUMN "submitted_by" UUID REFERENCES "users"("id"), ADD COLUMN "terms_version" TEXT;
