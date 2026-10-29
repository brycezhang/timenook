CREATE TABLE internal_project_admissions (
 id UUID PRIMARY KEY,
 project_id UUID NOT NULL UNIQUE REFERENCES projects(id),
 initiator_user_id UUID NOT NULL REFERENCES users(id),
 provision_key TEXT NOT NULL UNIQUE,
 request_hash CHAR(64) NOT NULL,
 profile_version TEXT NOT NULL,
 snapshot JSONB NOT NULL CHECK(snapshot->>'scope'='internal-acceptance'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,id)
);
CREATE TRIGGER immutable_internal_admission BEFORE UPDATE OR DELETE ON internal_project_admissions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE FUNCTION check_internal_project_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='internal_project_admissions' THEN
  IF NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.order_id IS NULL AND p.created_by=NEW.initiator_user_id::text) THEN RAISE EXCEPTION 'Internal project must have one matching source'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM internal_project_admissions a WHERE a.project_id=NEW.id AND (NEW.order_id IS NOT NULL OR NEW.created_by<>a.initiator_user_id::text)) THEN RAISE EXCEPTION 'Internal project source is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER internal_admission_source BEFORE INSERT ON internal_project_admissions FOR EACH ROW EXECUTE FUNCTION check_internal_project_source();
CREATE TRIGGER internal_project_source BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION check_internal_project_source();
ALTER TABLE project_service_terms ALTER COLUMN package_version_id DROP NOT NULL;
ALTER TABLE project_service_terms ADD COLUMN internal_admission_id UUID;
ALTER TABLE project_service_terms ADD CONSTRAINT service_terms_one_source CHECK(num_nonnulls(package_version_id,internal_admission_id)=1);
ALTER TABLE project_service_terms ADD CONSTRAINT service_terms_internal_source FOREIGN KEY(project_id,internal_admission_id) REFERENCES internal_project_admissions(project_id,id);
CREATE FUNCTION check_service_terms_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.internal_admission_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM internal_project_admissions a JOIN projects p ON p.id=a.project_id WHERE a.id=NEW.internal_admission_id AND a.project_id=NEW.project_id AND p.order_id IS NULL AND NEW.policy=jsonb_build_object('d02',a.snapshot->'admission'->'d02','d03',a.snapshot->'admission'->'d03')) THEN RAISE EXCEPTION 'Service terms must match internal source'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM projects p JOIN payment_orders o ON o.id=p.order_id WHERE p.id=NEW.project_id AND o.package_version_id=NEW.package_version_id AND NEW.policy=jsonb_build_object('d02',o.package_snapshot->'admission'->'d02','d03',o.package_snapshot->'admission'->'d03')) THEN RAISE EXCEPTION 'Service terms must match paid source'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_terms_source BEFORE INSERT ON project_service_terms FOR EACH ROW EXECUTE FUNCTION check_service_terms_source();
