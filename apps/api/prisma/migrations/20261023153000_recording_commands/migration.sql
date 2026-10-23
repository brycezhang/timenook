CREATE TABLE recording_commands(project_id UUID NOT NULL REFERENCES projects(id),operator_user_id UUID NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash CHAR(64) NOT NULL,PRIMARY KEY(project_id,operator_user_id,idempotency_key));
CREATE TRIGGER immutable_recording_command BEFORE UPDATE ON recording_commands FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
