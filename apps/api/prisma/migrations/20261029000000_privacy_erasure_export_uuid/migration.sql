-- T26: SQL CASE arms may be planned with concrete PL/pgSQL parameter values.
-- Only care_exports has a UUID package id; stable book-audio ids are text.
CREATE OR REPLACE FUNCTION privacy_erasure_allowed(table_name text,old_value jsonb,new_value jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE cleared text[]; col text; old_cleared text[]; new_cleared text[]; export_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM privacy_erasure_registry r WHERE r.table_name=$1) THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(value),'{}') INTO old_cleared FROM jsonb_array_elements_text(old_value->'privacy_erased_columns');
 SELECT COALESCE(array_agg(value),'{}') INTO new_cleared FROM jsonb_array_elements_text(new_value->'privacy_erased_columns');
 SELECT COALESCE(array_agg(c),'{}') INTO cleared FROM unnest(new_cleared) c WHERE NOT c=ANY(old_cleared);
 IF cardinality(cleared)=0 OR NOT old_cleared <@ new_cleared THEN RETURN false; END IF;
 IF table_name='care_exports' THEN
  export_id:=(old_value->>'id')::uuid;
 END IF;
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
    AND CASE WHEN d.scoped_export_id IS NULL THEN true WHEN r.table_name='care_exports' THEN d.scoped_export_id=export_id ELSE false END
    AND CASE WHEN r.table_name='care_exports' THEN privacy_export_has_category(old_value->'manifest',r.category) ELSE true END
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
