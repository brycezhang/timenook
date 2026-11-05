ALTER TABLE fulfillment_attempts ADD COLUMN printed_at timestamptz(3), ADD COLUMN printed_by uuid REFERENCES admin_accounts(id);
ALTER TABLE fulfillment_attempts ADD CONSTRAINT fulfillment_print_fact_pair CHECK ((printed_at IS NULL) = (printed_by IS NULL));
ALTER TABLE fulfillment_attempts ADD CONSTRAINT fulfillment_print_chronology CHECK (printed_at IS NULL OR (isfinite(printed_at) AND printed_at >= created_at AND (shipped_at IS NULL OR printed_at <= shipped_at)));
CREATE FUNCTION preserve_fulfillment_print_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.printed_at IS NOT NULL AND (NEW.printed_at IS DISTINCT FROM OLD.printed_at OR NEW.printed_by IS DISTINCT FROM OLD.printed_by) THEN
    RAISE EXCEPTION 'Completed printing fact is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_print_fact_immutable BEFORE UPDATE ON fulfillment_attempts FOR EACH ROW EXECUTE FUNCTION preserve_fulfillment_print_fact();

CREATE OR REPLACE FUNCTION protect_fulfillment_attempt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at THEN RAISE EXCEPTION 'Actual shipment time is immutable'; END IF;
 IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN RAISE EXCEPTION 'Actual delivery time is immutable'; END IF;
 IF NEW.shipped_at IS NOT NULL AND (NOT isfinite(NEW.shipped_at) OR NEW.shipped_at<NEW.created_at OR (NEW.delivered_at IS NOT NULL AND NEW.shipped_at>NEW.delivered_at)) THEN RAISE EXCEPTION 'Actual shipment chronology required'; END IF;
 IF (to_jsonb(NEW)-'state'-'receipt_ref'-'tracking'-'wechat'-'shipped_at'-'delivered_at'-'printed_at'-'printed_by') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'receipt_ref'-'tracking'-'wechat'-'shipped_at'-'delivered_at'-'printed_at'-'printed_by') THEN RAISE EXCEPTION 'Production attempt binding is immutable'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION privacy_deny_new_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; registry record;
BEGIN
 owner:=privacy_project_for(TG_TABLE_NAME,to_jsonb(NEW));
 IF owner IS NULL THEN RETURN NEW; END IF;
 FOR registry IN SELECT * FROM privacy_erasure_registry WHERE table_name=TG_TABLE_NAME LOOP
  IF TG_TABLE_NAME='photo_assets' AND ((registry.category='originalPhotos' AND to_jsonb(NEW)->>'kind'<>'original') OR (registry.category='derivedPhotos' AND to_jsonb(NEW)->>'kind'='original')) THEN CONTINUE; END IF;
  IF TG_TABLE_NAME='care_exports' AND registry.category IN ('originalAudio','transcripts','confirmedStories','bookPdf','originalPhotos','derivedPhotos') AND ((to_jsonb(NEW)->'manifest')='null'::jsonb OR NOT privacy_export_has_category(to_jsonb(NEW)->'manifest',registry.category)) AND (TG_OP='INSERT' OR (to_jsonb(OLD)->'manifest')='null'::jsonb OR NOT privacy_export_has_category(to_jsonb(OLD)->'manifest',registry.category)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND (scoped_export_id IS NULL OR (TG_TABLE_NAME='care_exports' AND scoped_export_id=(to_jsonb(NEW)->>'id')::uuid)) AND (categories ? 'all' OR categories ? registry.category)) OR EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=owner) THEN
   IF TG_OP='INSERT' THEN
    IF registry.category='activeData' AND TG_TABLE_NAME IN ('consent_records','assisted_sessions') AND (to_jsonb(NEW)->>'granted')::boolean=false AND EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND categories ? 'activeData' AND scoped_export_id IS NULL) AND NOT EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND categories ? 'all') AND NOT EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=owner) AND NOT EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM 'null'::jsonb) AND EXISTS(SELECT 1 FROM project_subjects s JOIN projects p ON p.id=s.project_id CROSS JOIN LATERAL (SELECT project_initiator_user_id(p.id) AS buyer_id) o WHERE o.buyer_id IS NOT NULL AND p.id=owner AND s.id=(to_jsonb(NEW)->>'subject_id')::uuid AND s.binding_version=(to_jsonb(NEW)->>'binding_version')::integer AND p.access_epoch=(to_jsonb(NEW)->>'access_epoch')::integer AND ((to_jsonb(NEW)->>'operator_user_id')::uuid IN (s.bound_user_id,o.buyer_id) OR (TG_TABLE_NAME='consent_records' AND to_jsonb(NEW)->>'method'='care_verified' AND (to_jsonb(NEW)->>'operator_user_id') IS NULL AND EXISTS(SELECT 1 FROM admin_accounts admin WHERE admin.id=(to_jsonb(NEW)->>'operator_admin_id')::uuid AND NOT admin.disabled AND 'care:write'=ANY(admin.permissions))))) THEN CONTINUE; END IF;
    IF registry.category='activeData' AND EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND categories ? 'activeData' AND scoped_export_id IS NULL) AND NOT EXISTS(SELECT 1 FROM privacy_deletions WHERE project_id=owner AND categories ? 'all') AND NOT EXISTS(SELECT 1 FROM privacy_recovery_holds WHERE project_id=owner) THEN
     -- journal_story_denial_guard independently checks every exact identity,
     -- version/hash, refusal flag and authentic positive confirmation basis.
     IF TG_TABLE_NAME='story_decisions' AND to_jsonb(NEW)->>'method'='journal_denial' AND NOT ((to_jsonb(NEW)->>'confirmed')::boolean AND (to_jsonb(NEW)->>'allow_in_book')::boolean) AND EXISTS(SELECT 1 FROM privacy_events e WHERE e.id=(to_jsonb(NEW)->>'id')::uuid AND e.project_id=owner AND e.kind='revocation' AND e.payload->>'operation'='story_decision' AND to_jsonb(NEW)->>'evidence_ref'='journal:'||e.hash) THEN CONTINUE; END IF;
     IF NOT EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM 'null'::jsonb) THEN
      IF TG_TABLE_NAME='fulfillment_records' AND to_jsonb(NEW)->>'kind' IN ('handoff','cancelled','cancellation_pending','receipt_unknown','receipt_accepted','receipt_cancelled','receipt_cancellation_rejected','shipping','delivery','printing_completed') AND EXISTS(SELECT 1 FROM fulfillment_commands c JOIN fulfillment_attempts a ON a.id=c.attempt_id WHERE a.id=(to_jsonb(NEW)->>'attempt_id')::uuid AND a.project_id=owner AND c.project_id=owner AND c.actor_id=(to_jsonb(NEW)->>'operator_admin_id')::uuid AND c.action=(CASE WHEN to_jsonb(NEW)->>'kind'='printing_completed' THEN 'printing' WHEN to_jsonb(NEW)->>'kind' LIKE 'receipt_%' THEN 'receipt' WHEN to_jsonb(NEW)->>'kind' IN ('cancelled','cancellation_pending') THEN 'cancel' ELSE to_jsonb(NEW)->>'kind' END)||':'||a.id::text) THEN CONTINUE; END IF;
      IF TG_TABLE_NAME='fulfillment_deliveries' AND EXISTS(SELECT 1 FROM fulfillment_attempts a JOIN fulfillment_commands c ON c.attempt_id=a.id WHERE a.id=(to_jsonb(NEW)->>'attempt_id')::uuid AND a.project_id=owner AND a.order_id=(to_jsonb(NEW)->>'order_id')::uuid AND a.state='shipped' AND a.shipped_at IS NOT NULL AND (to_jsonb(NEW)->>'occurred_at')::timestamptz>=a.shipped_at AND c.actor_id=(to_jsonb(NEW)->>'operator_admin_id')::uuid AND c.action='delivery:'||a.id::text) THEN CONTINUE; END IF;
      IF TG_TABLE_NAME='binding_changes' AND EXISTS(SELECT 1 FROM project_subjects s JOIN projects p ON p.id=s.project_id CROSS JOIN LATERAL (SELECT project_initiator_user_id(p.id) AS buyer_id) o WHERE o.buyer_id IS NOT NULL AND p.id=owner AND s.id=(to_jsonb(NEW)->>'subject_id')::uuid AND s.bound_user_id=(to_jsonb(NEW)->>'to_user_id')::uuid AND s.binding_version=(to_jsonb(NEW)->>'binding_version')::integer AND p.access_epoch=(to_jsonb(NEW)->>'access_epoch')::integer AND ((to_jsonb(NEW)->>'method'='care_verified' AND to_jsonb(NEW)->>'operator_realm'='admin' AND EXISTS(SELECT 1 FROM care_requests c WHERE c.id=(to_jsonb(NEW)->>'support_case_id')::uuid AND c.project_id=owner AND c.kind='rebind' AND c.state='completed' AND c.completed_by=(to_jsonb(NEW)->>'operator_id')::uuid AND c.target_user_id=s.bound_user_id AND c.source_binding_version=(to_jsonb(NEW)->>'source_binding_version')::integer)) OR (to_jsonb(NEW)->>'method'='initiator_review' AND to_jsonb(NEW)->>'operator_realm'='product' AND (to_jsonb(NEW)->>'operator_id')::uuid=o.buyer_id AND (to_jsonb(NEW)->>'source_binding_version')::integer=0 AND s.binding_version=1 AND EXISTS(SELECT 1 FROM binding_requests b JOIN invitations i ON i.id=b.invitation_id WHERE i.project_id=owner AND b.applicant_user_id=s.bound_user_id AND b.state='approved' AND b.approved_by=o.buyer_id)))) THEN CONTINUE; END IF;
     END IF;
    END IF;
    IF TG_TABLE_NAME IN ('refunds','refund_commands','payment_commands','care_requests') AND NOT EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM 'null'::jsonb) THEN CONTINUE; END IF;
    RAISE EXCEPTION 'Deleted project/category cannot acquire new payload';
   END IF;
   -- Lifecycle-only updates may continue on retained task/financial shells.
   IF EXISTS(SELECT 1 FROM unnest(registry.columns) c WHERE to_jsonb(NEW)->c IS DISTINCT FROM to_jsonb(OLD)->c) AND NOT privacy_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION 'Deleted payload changes require exact monotonic erasure'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
