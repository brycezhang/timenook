ALTER TABLE project_subjects ADD CONSTRAINT project_subjects_project_id_id_key UNIQUE (project_id,id);
ALTER TABLE actual_plan_questions ADD CONSTRAINT actual_plan_questions_project_id_id_key UNIQUE (project_id,id);
CREATE TABLE interviews (
 id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES projects(id),
 client_interview_id UUID NOT NULL,
 actual_question_id UUID NOT NULL UNIQUE,
 subject_id UUID NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id),
 binding_version INTEGER NOT NULL,
 access_epoch INTEGER NOT NULL,
 method TEXT NOT NULL CHECK (method IN ('self_wechat','assisted')),
 assisted_session_id UUID REFERENCES assisted_sessions(id),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (project_id,subject_id) REFERENCES project_subjects(project_id,id),
 FOREIGN KEY (project_id,actual_question_id) REFERENCES actual_plan_questions(project_id,id),
 UNIQUE(project_id,client_interview_id), UNIQUE(project_id,id), UNIQUE(project_id,id,actual_question_id),
 CHECK ((method='assisted')=(assisted_session_id IS NOT NULL))
);
CREATE TRIGGER immutable_interview BEFORE UPDATE ON interviews FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
