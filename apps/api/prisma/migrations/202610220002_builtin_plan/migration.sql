CREATE TABLE "outline_template_versions" (
  "template_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "content" JSONB NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "review_status" TEXT NOT NULL,
  PRIMARY KEY ("template_id", "version")
);

CREATE TABLE "projects" (
  "id" UUID PRIMARY KEY,
  "created_by" TEXT NOT NULL,
  "source_template_id" TEXT NOT NULL,
  "source_template_version" INTEGER NOT NULL,
  "current_revision" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "projects_source_template_id_source_template_version_fkey"
    FOREIGN KEY ("source_template_id", "source_template_version")
    REFERENCES "outline_template_versions" ("template_id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "plan_revisions" (
  "project_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "content" JSONB NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_by" TEXT NOT NULL,
  PRIMARY KEY ("project_id", "revision"),
  CONSTRAINT "plan_revisions_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Initial creation and revision append update both sides within one transaction.
-- Deferral permits this while preventing a current pointer into another project
-- or to a revision that was never committed.
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_current_revision_fkey"
  FOREIGN KEY ("id", "current_revision") REFERENCES "plan_revisions" ("project_id", "revision")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "interview_preferences" (
  "project_id" UUID PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "blocked_topics" TEXT[] NOT NULL DEFAULT '{}',
  "updated_by" TEXT,
  CONSTRAINT "interview_preferences_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE FUNCTION reject_plan_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Plan revisions are immutable; append a new revision';
END;
$$;
CREATE TRIGGER immutable_plan_revision
  BEFORE UPDATE ON "plan_revisions"
  FOR EACH ROW EXECUTE FUNCTION reject_plan_revision_update();

-- A code release may only append a new template version. A migration that
-- deliberately changes this policy must be explicit; ordinary writes cannot.
CREATE FUNCTION reject_template_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Template versions are immutable';
END;
$$;
CREATE TRIGGER immutable_template_version
  BEFORE UPDATE OR DELETE ON "outline_template_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_template_mutation();
