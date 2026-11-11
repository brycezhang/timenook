-- Photos belong to the project; immutable interview snapshots reference project assets.
ALTER TABLE photo_references DROP CONSTRAINT photo_references_project_id_interview_id_photo_id_fkey;
ALTER TABLE photo_intents DROP CONSTRAINT photo_intents_project_id_interview_id_actual_question_id_fkey;
ALTER TABLE photo_intents DROP CONSTRAINT photo_intents_project_id_interview_id_id_key;
ALTER TABLE photo_intents DROP COLUMN interview_id, DROP COLUMN actual_question_id;
ALTER TABLE photo_references ADD CONSTRAINT photo_references_project_photo_fkey
  FOREIGN KEY (project_id, photo_id) REFERENCES photo_intents(project_id, id);
