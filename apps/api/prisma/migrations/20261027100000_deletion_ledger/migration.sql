-- T26: business backup contains projections only; independent source is publication authority.
ALTER TABLE refunds ADD COLUMN production_evidence_hash char(64);
UPDATE refunds SET production_evidence_hash=encode(sha256(convert_to(production_evidence,'UTF8')),'hex') WHERE production_evidence IS NOT NULL;
CREATE TABLE privacy_recovery_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), database_id uuid NOT NULL DEFAULT gen_random_uuid(), authority_generation integer NOT NULL DEFAULT 1 CHECK(authority_generation>0),
 source_id uuid, checkpoint_generation bigint NOT NULL DEFAULT 0, checkpoint_hash text
);
INSERT INTO privacy_recovery_state(singleton) VALUES(true);
CREATE TABLE privacy_events (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),kind text NOT NULL CHECK(kind IN ('revocation','deletion')),
 source_id uuid NOT NULL,generation bigint NOT NULL,hash text NOT NULL,payload jsonb NOT NULL,occurred_at timestamptz(3) NOT NULL,
 UNIQUE(source_id,generation)
);
CREATE TABLE privacy_recovery_holds(event_id uuid PRIMARY KEY REFERENCES privacy_events(id),project_id uuid NOT NULL REFERENCES projects(id),reason text NOT NULL);
CREATE TRIGGER immutable_privacy_hold BEFORE UPDATE OR DELETE ON privacy_recovery_holds FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TABLE privacy_deletions (
 id uuid PRIMARY KEY REFERENCES privacy_events(id),project_id uuid NOT NULL REFERENCES projects(id),request_id uuid,scoped_export_id uuid,
 trigger text NOT NULL CHECK(trigger IN ('verified_request','retention_expiry')),categories jsonb NOT NULL,effective_at timestamptz(3) NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX privacy_deletions_project ON privacy_deletions(project_id);
CREATE TABLE privacy_deletion_items (
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES privacy_deletions(id),project_id uuid NOT NULL REFERENCES projects(id),category text NOT NULL,layer text NOT NULL,
 target_table text,target_key jsonb,target_columns text[],locator jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','awaiting_evidence')),deadline timestamptz(3),completed_at timestamptz(3),reason text,evidence_ref text,
 UNIQUE(event_id,category,layer,target_table,target_key)
);
CREATE TABLE privacy_owned_resources (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),category text NOT NULL,storage_scope text NOT NULL,object_keys jsonb NOT NULL,directory text,created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_privacy_event BEFORE UPDATE OR DELETE ON privacy_events FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_privacy_deletion BEFORE UPDATE OR DELETE ON privacy_deletions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_privacy_owner BEFORE UPDATE OR DELETE ON privacy_owned_resources FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TABLE privacy_erasure_registry(table_name text NOT NULL,category text NOT NULL,columns text[] NOT NULL,key_columns text[] NOT NULL,PRIMARY KEY(table_name,category));
INSERT INTO privacy_erasure_registry VALUES('projects','activeData',ARRAY['book_title']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('project_subjects','activeData',ARRAY['name']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('payment_orders','activeData',ARRAY['subject_name','book_title','recipient']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('payment_submissions','activeData',ARRAY['parameters']::text[],ARRAY['order_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('payment_commands','activeData',ARRAY['result']::text[],ARRAY['order_id','action','key']::text[]);
INSERT INTO privacy_erasure_registry VALUES('plan_revisions','activeData',ARRAY['content']::text[],ARRAY['project_id','revision']::text[]);
INSERT INTO privacy_erasure_registry VALUES('interview_preferences','activeData',ARRAY['blocked_topics','question_states']::text[],ARRAY['project_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('plan_preference_decisions','activeData',ARRAY['blocked_topics','question_states']::text[],ARRAY['project_id','version']::text[]);
INSERT INTO privacy_erasure_registry VALUES('plan_directory_versions','activeData',ARRAY['chapters']::text[],ARRAY['project_id','version']::text[]);
INSERT INTO privacy_erasure_registry VALUES('actual_plan_questions','activeData',ARRAY['snapshot','source']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('formal_transcripts','transcripts',ARRAY['text']::text[],ARRAY['task_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_generations','transcripts',ARRAY['resolved_manifest']::text[],ARRAY['task_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_generations','activeData',ARRAY['preferences','resolved_manifest']::text[],ARRAY['task_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_sources','activeData',ARRAY['question']::text[],ARRAY['task_id','clip_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('followup_generations','transcripts',ARRAY['input','result']::text[],ARRAY['task_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_revisions','confirmedStories',ARRAY['title','theme','paragraphs','review_items','review_resolutions','notes','audio_manifest','photo_snapshot']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_revisions','transcripts',ARRAY['source_manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('photo_assets','derivedPhotos',ARRAY['metadata']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('photo_assets','originalPhotos',ARRAY['metadata']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('photo_references','derivedPhotos',ARRAY['caption']::text[],ARRAY['snapshot_id','position']::text[]);
INSERT INTO privacy_erasure_registry VALUES('book_versions','bookPdf',ARRAY['snapshot']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('book_outputs','bookPdf',ARRAY['manifest','inspection']::text[],ARRAY['book_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('book_audio_entries','originalAudio',ARRAY['audio']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('book_cover_versions','activeData',ARRAY['salutation']::text[],ARRAY['project_id','version']::text[]);
INSERT INTO privacy_erasure_registry VALUES('first_copy_addresses','activeData',ARRAY['value']::text[],ARRAY['project_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('first_copy_orders','activeData',ARRAY['address']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('fulfillment_attempts','activeData',ARRAY['address','tracking','wechat','receipt_ref','supplier_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('fulfillment_records','activeData',ARRAY['evidence']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('fulfillment_deliveries','activeData',ARRAY['evidence_ref']::text[],ARRAY['order_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','exportPackages',ARRAY['manifest','recipient_ref','evidence_ref','delivery_evidence']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_requests','activeData',ARRAY['verification_evidence','verification_notice']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('consent_records','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('assisted_sessions','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('assisted_version_evidence','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('binding_changes','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_decisions','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_care_grants','activeData',ARRAY['evidence_ref']::text[],ARRAY['case_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('book_confirmations','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('fulfillment_grants','activeData',ARRAY['evidence_ref']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('production_tasks','activeData',ARRAY['processing_grant','configuration']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('task_attempts','activeData',ARRAY['configuration']::text[],ARRAY['request_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('refunds','activeData',ARRAY['evidence_ref','production_evidence']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('refund_commands','activeData',ARRAY['payload']::text[],ARRAY['refund_id','actor_id','action','key']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','originalAudio',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','originalPhotos',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','derivedPhotos',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','transcripts',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','confirmedStories',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','bookPdf',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('care_exports','activeData',ARRAY['manifest']::text[],ARRAY['id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('quality_evidence','activeData',ARRAY['description']::text[],ARRAY['request_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('quality_requests','activeData',ARRAY['assignment_evidence_ref','review_evidence_ref']::text[],ARRAY['id']::text[]);
ALTER TABLE quality_evidence ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE quality_requests ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE quality_evidence ADD CONSTRAINT quality_erasure_pair CHECK(erased_at IS NULL OR description IS NULL);
INSERT INTO privacy_erasure_registry VALUES('followup_generations','activeData',ARRAY['input','result']::text[],ARRAY['task_id']::text[]);
INSERT INTO privacy_erasure_registry VALUES('story_revisions','activeData',ARRAY['source_manifest']::text[],ARRAY['id']::text[]);
ALTER TABLE "projects" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "projects" ALTER COLUMN "book_title" DROP NOT NULL;
ALTER TABLE "project_subjects" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "project_subjects" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "payment_orders" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "payment_orders" ALTER COLUMN "subject_name" DROP NOT NULL;
ALTER TABLE "payment_orders" ALTER COLUMN "book_title" DROP NOT NULL;
ALTER TABLE "payment_orders" ALTER COLUMN "recipient" DROP NOT NULL;
ALTER TABLE "payment_submissions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "payment_submissions" ALTER COLUMN "parameters" DROP NOT NULL;
ALTER TABLE "payment_commands" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "payment_commands" ALTER COLUMN "result" DROP NOT NULL;
ALTER TABLE "plan_revisions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "plan_revisions" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "interview_preferences" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "interview_preferences" ALTER COLUMN "blocked_topics" DROP NOT NULL;
ALTER TABLE "interview_preferences" ALTER COLUMN "question_states" DROP NOT NULL;
ALTER TABLE "plan_preference_decisions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "plan_preference_decisions" ALTER COLUMN "blocked_topics" DROP NOT NULL;
ALTER TABLE "plan_preference_decisions" ALTER COLUMN "question_states" DROP NOT NULL;
ALTER TABLE "plan_directory_versions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "plan_directory_versions" ALTER COLUMN "chapters" DROP NOT NULL;
ALTER TABLE "actual_plan_questions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "actual_plan_questions" ALTER COLUMN "snapshot" DROP NOT NULL;
ALTER TABLE "actual_plan_questions" ALTER COLUMN "source" DROP NOT NULL;
ALTER TABLE "formal_transcripts" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "formal_transcripts" ALTER COLUMN "text" DROP NOT NULL;
ALTER TABLE "story_generations" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "story_generations" ALTER COLUMN "resolved_manifest" DROP NOT NULL;
ALTER TABLE "story_generations" ALTER COLUMN "preferences" DROP NOT NULL;
ALTER TABLE "story_sources" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "story_sources" ALTER COLUMN "question" DROP NOT NULL;
ALTER TABLE "followup_generations" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "followup_generations" ALTER COLUMN "input" DROP NOT NULL;
ALTER TABLE "followup_generations" ALTER COLUMN "result" DROP NOT NULL;
ALTER TABLE "story_revisions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "story_revisions" ALTER COLUMN "title" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "theme" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "paragraphs" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "review_items" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "review_resolutions" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "notes" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "audio_manifest" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "photo_snapshot" DROP NOT NULL;
ALTER TABLE "story_revisions" ALTER COLUMN "source_manifest" DROP NOT NULL;
ALTER TABLE "photo_assets" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "photo_assets" ALTER COLUMN "metadata" DROP NOT NULL;
ALTER TABLE "photo_references" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "photo_references" ALTER COLUMN "caption" DROP NOT NULL;
ALTER TABLE "book_versions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "book_versions" ALTER COLUMN "snapshot" DROP NOT NULL;
ALTER TABLE "book_outputs" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "book_outputs" ALTER COLUMN "manifest" DROP NOT NULL;
ALTER TABLE "book_outputs" ALTER COLUMN "inspection" DROP NOT NULL;
ALTER TABLE "book_audio_entries" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "book_audio_entries" ALTER COLUMN "audio" DROP NOT NULL;
ALTER TABLE "book_cover_versions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "book_cover_versions" ALTER COLUMN "salutation" DROP NOT NULL;
ALTER TABLE "first_copy_addresses" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "first_copy_addresses" ALTER COLUMN "value" DROP NOT NULL;
ALTER TABLE "first_copy_orders" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "first_copy_orders" ALTER COLUMN "address" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "address" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "tracking" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "wechat" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "receipt_ref" DROP NOT NULL;
ALTER TABLE "fulfillment_attempts" ALTER COLUMN "supplier_ref" DROP NOT NULL;
ALTER TABLE "fulfillment_records" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillment_records" ALTER COLUMN "evidence" DROP NOT NULL;
ALTER TABLE "fulfillment_deliveries" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillment_deliveries" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "care_exports" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "care_exports" ALTER COLUMN "manifest" DROP NOT NULL;
ALTER TABLE "care_exports" ALTER COLUMN "recipient_ref" DROP NOT NULL;
ALTER TABLE "care_exports" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "care_exports" ALTER COLUMN "delivery_evidence" DROP NOT NULL;
ALTER TABLE "care_requests" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "care_requests" ALTER COLUMN "verification_evidence" DROP NOT NULL;
ALTER TABLE "care_requests" ALTER COLUMN "verification_notice" DROP NOT NULL;
ALTER TABLE "consent_records" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "consent_records" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "assisted_sessions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "assisted_sessions" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "assisted_version_evidence" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "assisted_version_evidence" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "binding_changes" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "binding_changes" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "story_decisions" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "story_decisions" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "story_care_grants" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "story_care_grants" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "book_confirmations" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "book_confirmations" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "fulfillment_grants" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillment_grants" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "production_tasks" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "production_tasks" ALTER COLUMN "processing_grant" DROP NOT NULL;
ALTER TABLE "production_tasks" ALTER COLUMN "configuration" DROP NOT NULL;
ALTER TABLE "task_attempts" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "task_attempts" ALTER COLUMN "configuration" DROP NOT NULL;
ALTER TABLE "refunds" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "refunds" ALTER COLUMN "evidence_ref" DROP NOT NULL;
ALTER TABLE "refunds" ALTER COLUMN "production_evidence" DROP NOT NULL;
ALTER TABLE "refund_commands" ADD COLUMN privacy_erased_columns text[] NOT NULL DEFAULT '{}';
ALTER TABLE "refund_commands" ALTER COLUMN "payload" DROP NOT NULL;

-- The transcript's original hash remains an audit/FK fact after its payload disappears.
ALTER TABLE formal_transcripts DROP CONSTRAINT formal_transcripts_check;
ALTER TABLE formal_transcripts ADD CONSTRAINT formal_transcripts_sha256_check CHECK(text IS NULL OR sha256=encode(sha256(convert_to(text,'UTF8')),'hex'));
CREATE FUNCTION privacy_row_key(table_name text,row_value jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_object_agg(k,row_value->k) FROM (SELECT DISTINCT unnest(key_columns) k FROM privacy_erasure_registry WHERE table_name=$1) keys;
$$;
-- A source category only invalidates ZIPs that actually carry that category.
-- A missing manifest is unresolved, so it remains conservatively denied.
CREATE FUNCTION privacy_export_has_category(manifest jsonb,category text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE file jsonb; path text;
BEGIN
 IF category IN ('all','activeData','exportPackages') THEN RETURN true; END IF;
 IF category NOT IN ('originalAudio','transcripts','confirmedStories','bookPdf','originalPhotos','derivedPhotos') THEN RETURN false; END IF;
 IF manifest IS NULL OR manifest='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(manifest->'files') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Unknown export category ownership'; END IF;
 FOR file IN SELECT value FROM jsonb_array_elements(manifest->'files') LOOP
  path:=file->>'path';
  IF path='README.txt' THEN CONTINUE; END IF;
  IF path IS NULL OR path !~ '^(audio|transcripts|stories|books|photos)/' THEN RAISE EXCEPTION 'Unknown export source category'; END IF;
  IF path LIKE 'photos/%' AND COALESCE(file->'source'->>'kind','') NOT IN ('original','preview','print') THEN RAISE EXCEPTION 'Unknown exported photo ownership'; END IF;
  IF (category='originalAudio' AND path LIKE 'audio/%') OR (category='transcripts' AND path LIKE 'transcripts/%') OR (category='confirmedStories' AND path LIKE 'stories/%') OR (category='bookPdf' AND path LIKE 'books/%') OR (category='originalPhotos' AND path LIKE 'photos/%' AND file->'source'->>'kind'='original') OR (category='derivedPhotos' AND path LIKE 'photos/%' AND file->'source'->>'kind'<>'original') THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
CREATE FUNCTION privacy_erasure_allowed(table_name text,old_value jsonb,new_value jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE cleared text[]; col text; old_cleared text[]; new_cleared text[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM privacy_erasure_registry r WHERE r.table_name=$1) THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(value),'{}') INTO old_cleared FROM jsonb_array_elements_text(old_value->'privacy_erased_columns');
 SELECT COALESCE(array_agg(value),'{}') INTO new_cleared FROM jsonb_array_elements_text(new_value->'privacy_erased_columns');
 SELECT COALESCE(array_agg(c),'{}') INTO cleared FROM unnest(new_cleared) c WHERE NOT c=ANY(old_cleared);
 IF cardinality(cleared)=0 OR NOT old_cleared <@ new_cleared THEN RETURN false; END IF;
 IF table_name='quality_evidence' THEN
  IF NOT 'description'=ANY(cleared) THEN RETURN false; END IF;
  IF old_value->'erased_at'<>'null'::jsonb THEN
   IF old_value->'erased_at' IS DISTINCT FROM new_value->'erased_at' THEN RETURN false; END IF;
  ELSIF new_value->'erased_at'='null'::jsonb OR (new_value->>'erased_at')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',statement_timestamp()) THEN RETURN false;
  END IF;
  IF (old_value-cleared-'privacy_erased_columns'-'erased_at') IS DISTINCT FROM (new_value-cleared-'privacy_erased_columns'-'erased_at') THEN RETURN false; END IF;
 ELSE
  IF (old_value-cleared-'privacy_erased_columns') IS DISTINCT FROM (new_value-cleared-'privacy_erased_columns') THEN RETURN false; END IF;
 END IF;
 FOREACH col IN ARRAY cleared LOOP
  IF new_value->col IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(
   SELECT 1 FROM privacy_deletion_items i JOIN privacy_erasure_registry r ON r.table_name=i.target_table AND r.category=i.category
   JOIN privacy_deletions d ON d.id=i.event_id
   WHERE i.layer='active_database' AND i.target_table=$1 AND i.target_key=privacy_row_key($1,old_value)
    AND i.project_id=d.project_id AND i.project_id=privacy_project_for($1,old_value) AND (r.table_name<>'photo_assets' OR (r.category='originalPhotos' AND old_value->>'kind'='original') OR (r.category='derivedPhotos' AND old_value->>'kind'<>'original')) AND col=ANY(i.target_columns) AND col=ANY(r.columns)
    AND (d.categories ? 'all' OR d.categories ? r.category)
    AND CASE WHEN d.scoped_export_id IS NULL THEN true WHEN r.table_name='care_exports' THEN d.scoped_export_id=(old_value->>'id')::uuid ELSE false END
    AND CASE WHEN r.table_name='care_exports' THEN privacy_export_has_category(old_value->'manifest',r.category) ELSE true END
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- Existing immutable guards retain every original predicate. Only this explicit,
-- item-scoped monotonic erasure branch may return early; no session bypass exists.
DO $patch$
DECLARE f record; definition text;
BEGIN
 FOR f IN SELECT DISTINCT p.oid FROM pg_proc p JOIN pg_trigger t ON t.tgfoid=p.oid JOIN pg_class c ON c.oid=t.tgrelid
  JOIN privacy_erasure_registry r ON r.table_name=c.relname WHERE NOT t.tgisinternal AND c.relnamespace=current_schema()::regnamespace AND p.pronamespace=current_schema()::regnamespace
 LOOP
  SELECT pg_get_functiondef(f.oid) INTO definition;
  definition:=regexp_replace(definition,'BEGIN',E'BEGIN\n IF TG_OP=''UPDATE'' AND privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;','i');
  EXECUTE definition;
 END LOOP;
END $patch$;
CREATE FUNCTION privacy_payload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text; old_cols text[]; owner uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='task_attempts' AND to_jsonb(OLD)->>'state'='preparing' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Privacy shells and their owning facts are retained';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='quality_evidence' AND to_jsonb(NEW)->'erased_at' IS DISTINCT FROM to_jsonb(OLD)->'erased_at' THEN
   IF to_jsonb(OLD)->'erased_at'<>'null'::jsonb OR NOT privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION 'Erasure receipt timestamp is monotonic and item-scoped'; END IF;
  END IF;
  old_cols:=OLD.privacy_erased_columns;
  IF NOT old_cols <@ NEW.privacy_erased_columns THEN RAISE EXCEPTION 'Erasure cannot be undone'; END IF;
  FOREACH col IN ARRAY old_cols LOOP
   IF to_jsonb(NEW)->col IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Erased payload cannot be restored'; END IF;
  END LOOP;
  IF NEW.privacy_erased_columns IS DISTINCT FROM old_cols AND NOT privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION 'Erasure requires exact durable deletion item'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "projects" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "project_subjects" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "payment_orders" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "payment_submissions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "payment_commands" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "plan_revisions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "interview_preferences" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "plan_preference_decisions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "plan_directory_versions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "actual_plan_questions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "formal_transcripts" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "story_generations" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "story_sources" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "followup_generations" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "story_revisions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "photo_assets" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "photo_references" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "book_versions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "book_outputs" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "book_audio_entries" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "book_cover_versions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "first_copy_addresses" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "first_copy_orders" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "fulfillment_attempts" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "fulfillment_records" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "fulfillment_deliveries" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "care_exports" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "care_requests" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "consent_records" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "assisted_sessions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "assisted_version_evidence" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "binding_changes" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "story_decisions" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "story_care_grants" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "book_confirmations" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "fulfillment_grants" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "production_tasks" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "task_attempts" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON "refund_commands" FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE FUNCTION privacy_project_for(table_name text,row_value jsonb) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
BEGIN
 CASE table_name
WHEN 'projects' THEN RETURN (row_value->>'id')::uuid;
WHEN 'project_subjects' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'payment_orders' THEN RETURN (SELECT id FROM projects WHERE order_id=(row_value->>'id')::uuid);
WHEN 'payment_submissions' THEN RETURN (SELECT id FROM projects WHERE order_id=(row_value->>'order_id')::uuid);
WHEN 'payment_commands' THEN RETURN (SELECT id FROM projects WHERE order_id=(row_value->>'order_id')::uuid);
WHEN 'plan_revisions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'interview_preferences' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'plan_preference_decisions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'plan_directory_versions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'actual_plan_questions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'formal_transcripts' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'story_generations' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'story_sources' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'followup_generations' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'story_revisions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'photo_assets' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'photo_references' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'book_versions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'book_outputs' THEN RETURN (SELECT project_id FROM book_versions WHERE id=(row_value->>'book_id')::uuid);
WHEN 'book_audio_entries' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'book_cover_versions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'first_copy_addresses' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'first_copy_orders' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'fulfillment_attempts' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'fulfillment_records' THEN RETURN (SELECT project_id FROM fulfillment_attempts WHERE id=(row_value->>'attempt_id')::uuid);
WHEN 'fulfillment_deliveries' THEN RETURN (SELECT project_id FROM fulfillment_attempts WHERE id=(row_value->>'attempt_id')::uuid);
WHEN 'care_exports' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'care_requests' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'consent_records' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'assisted_sessions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'assisted_version_evidence' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'binding_changes' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'story_decisions' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'story_care_grants' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'book_confirmations' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'fulfillment_grants' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'production_tasks' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'task_attempts' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'refunds' THEN RETURN (row_value->>'project_id')::uuid;
WHEN 'refund_commands' THEN RETURN (SELECT project_id FROM refunds WHERE id=(row_value->>'refund_id')::uuid);
ELSE RETURN (row_value->>'project_id')::uuid; END CASE;
END $$;
CREATE FUNCTION privacy_deny_new_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; registry record;
BEGIN
 owner:=privacy_project_for(TG_TABLE_NAME,to_jsonb(NEW));
 IF owner IS NULL THEN RETURN NEW; END IF;
 FOR registry IN SELECT * FROM privacy_erasure_registry WHERE table_name=TG_TABLE_NAME LOOP
  IF TG_TABLE_NAME='photo_assets' AND ((registry.category='originalPhotos' AND to_jsonb(NEW)->>'kind'<>'original') OR (registry.category='derivedPhotos' AND to_jsonb(NEW)->>'kind'='original')) THEN CONTINUE; END IF;
  IF TG_TABLE_NAME='care_exports' AND registry.category IN ('originalAudio','transcripts','confirmedStories','bookPdf','originalPhotos','derivedPhotos') AND ((to_jsonb(NEW)->'manifest')='null'::jsonb OR NOT privacy_export_has_category(to_jsonb(NEW)->'manifest',registry.category)) AND (TG_OP='INSERT' OR (to_jsonb(OLD)->'manifest')='null'::jsonb OR NOT privacy_export_has_category(to_jsonb(OLD)->'manifest',registry.category)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND (scoped_export_id IS NULL OR (TG_TABLE_NAME='care_exports' AND scoped_export_id=(to_jsonb(NEW)->>'id')::uuid)) AND (categories ? 'all' OR categories ? registry.category)) OR EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=owner) THEN
   IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME='consent_records' AND (to_jsonb(NEW)->>'granted')::boolean=false AND NOT EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND categories ? 'all') AND NOT EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=owner) AND NOT EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM 'null'::jsonb) THEN CONTINUE; END IF;
    IF TG_TABLE_NAME IN ('refunds','refund_commands','payment_commands','care_requests') AND NOT EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM 'null'::jsonb) THEN CONTINUE; END IF;
    RAISE EXCEPTION 'Deleted project/category cannot acquire new payload';
   END IF;
   -- Lifecycle-only updates may continue on retained task/financial shells.
   IF EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM to_jsonb(OLD)->c) AND NOT privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION 'Deleted payload changes require exact monotonic erasure'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "projects" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "project_subjects" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "payment_orders" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "payment_submissions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "payment_commands" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "plan_revisions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "interview_preferences" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "plan_preference_decisions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "plan_directory_versions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "actual_plan_questions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "formal_transcripts" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "story_generations" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "story_sources" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "followup_generations" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "story_revisions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "photo_assets" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "photo_references" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "book_versions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "book_outputs" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "book_audio_entries" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "book_cover_versions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "first_copy_addresses" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "first_copy_orders" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "fulfillment_attempts" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "fulfillment_records" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "fulfillment_deliveries" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "care_exports" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "care_requests" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "consent_records" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "assisted_sessions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "assisted_version_evidence" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "binding_changes" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "story_decisions" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "story_care_grants" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "book_confirmations" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "fulfillment_grants" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "production_tasks" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "task_attempts" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON "refund_commands" FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON quality_evidence FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON quality_requests FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON quality_evidence FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON quality_requests FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
CREATE FUNCTION privacy_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deletion targets are retained'; END IF;
 IF NEW.deadline IS DISTINCT FROM OLD.deadline THEN RAISE EXCEPTION 'Original deletion deadline is immutable'; END IF;
 IF (to_jsonb(NEW)-'state'-'deadline'-'completed_at'-'reason'-'evidence_ref') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'deadline'-'completed_at'-'reason'-'evidence_ref') THEN RAISE EXCEPTION 'Deletion target is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_item_guard BEFORE UPDATE OR DELETE ON privacy_deletion_items FOR EACH ROW EXECUTE FUNCTION privacy_item_guard();

ALTER TABLE actual_plan_questions DROP CONSTRAINT actual_question_source_choice;
ALTER TABLE actual_plan_questions ADD CONSTRAINT actual_question_source_choice CHECK (privacy_erased_columns @> ARRAY['source']::text[] OR ((CASE WHEN question_key IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN starter_kind IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END)=1));
CREATE TRIGGER immutable_erasure_registry BEFORE INSERT OR UPDATE OR DELETE ON privacy_erasure_registry FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

CREATE FUNCTION protect_refund_evidence_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.production_evidence_hash IS NOT NULL AND NEW.production_evidence_hash IS DISTINCT FROM OLD.production_evidence_hash THEN RAISE EXCEPTION 'Financial review evidence hash is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_refund_evidence_hash BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION protect_refund_evidence_hash();

CREATE TABLE privacy_item_commands(project_id uuid NOT NULL REFERENCES projects(id),case_id uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,key text NOT NULL,request_hash char(64) NOT NULL,PRIMARY KEY(case_id,actor_id,action,key));
CREATE TRIGGER immutable_privacy_item_command BEFORE UPDATE OR DELETE ON privacy_item_commands FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

-- A restored rejection names its authenticated source, never fabricated original
-- self/assisted evidence. Public command DTOs cannot select this provenance.
ALTER TABLE story_decisions DROP CONSTRAINT story_decisions_method_check;
ALTER TABLE story_decisions ADD CONSTRAINT story_decisions_method_check CHECK(method IN ('self_wechat','assisted','journal_denial'));
CREATE FUNCTION protect_journal_story_denial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.method IS DISTINCT FROM OLD.method THEN RAISE EXCEPTION 'Decision provenance is immutable'; END IF;
 IF TG_OP='INSERT' AND NEW.method='journal_denial' THEN
  IF NEW.assisted_evidence_id IS NOT NULL OR (NEW.confirmed AND NEW.allow_in_book) OR NOT EXISTS(
   SELECT 1 FROM privacy_events e WHERE e.id=NEW.id AND e.project_id=NEW.project_id AND e.kind='revocation' AND e.payload->>'operation'='story_decision'
   AND NEW.evidence_ref='journal:'||e.hash
   AND e.payload->'decision'->>'id'=NEW.id::text
   AND e.payload->'decision'->>'subjectId'=NEW.subject_id::text
   AND e.payload->'decision'->>'operatorUserId'=NEW.operator_user_id::text
   AND e.payload->'decision'->>'storyId'=NEW.story_id::text
   AND e.payload->'decision'->>'revisionId'=NEW.revision_id::text
   AND e.payload->'decision'->>'contentHash'=NEW.content_hash::text
   AND (e.payload->'decision'->>'bindingVersion')::integer=NEW.binding_version
   AND (e.payload->'decision'->>'accessEpoch')::integer=NEW.access_epoch
   AND (e.payload->'decision'->>'confirmed')::boolean=NEW.confirmed
   AND (e.payload->'decision'->>'allowInBook')::boolean=NEW.allow_in_book
   AND (NOT NEW.confirmed OR EXISTS(SELECT 1 FROM story_decisions basis WHERE basis.id<>NEW.id AND basis.method<>'journal_denial' AND basis.project_id=NEW.project_id AND basis.subject_id=NEW.subject_id AND basis.revision_id=NEW.revision_id AND basis.content_hash=NEW.content_hash AND basis.binding_version=NEW.binding_version AND basis.access_epoch=NEW.access_epoch AND basis.confirmed))
  ) THEN RAISE EXCEPTION 'Journal provenance can only project the exact authenticated rejection'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_story_denial_guard BEFORE INSERT OR UPDATE ON story_decisions FOR EACH ROW EXECUTE FUNCTION protect_journal_story_denial();
