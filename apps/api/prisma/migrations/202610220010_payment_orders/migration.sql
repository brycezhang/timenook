CREATE TABLE payment_orders (
 id UUID PRIMARY KEY,
 buyer_id UUID NOT NULL REFERENCES users(id),
 app_id TEXT NOT NULL, open_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
 out_trade_no TEXT NOT NULL UNIQUE,
 idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
 amount INTEGER NOT NULL CHECK (amount = 99900), currency TEXT NOT NULL CHECK (currency = 'CNY'),
 mode TEXT NOT NULL CHECK (mode = 'local-verification'),
 package_version_id UUID NOT NULL REFERENCES package_versions(id),
 package_snapshot JSONB NOT NULL, recipient JSONB NOT NULL, template JSONB NOT NULL,
 shipping_region_code TEXT NOT NULL, subject_name TEXT, book_title TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','paid','closed')),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE(buyer_id,idempotency_key),
 FOREIGN KEY(app_id,open_id) REFERENCES wechat_identities(app_id,open_id)
);
CREATE INDEX payment_orders_buyer_created ON payment_orders(buyer_id,created_at);
CREATE FUNCTION protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='paid' AND NEW.state <> 'paid' THEN RAISE EXCEPTION 'Verified payment cannot be erased'; END IF;
 IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
  RAISE EXCEPTION 'Order snapshots are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_snapshot BEFORE UPDATE ON payment_orders FOR EACH ROW EXECUTE FUNCTION protect_order_snapshot();
CREATE TABLE payment_submissions (
 order_id UUID PRIMARY KEY REFERENCES payment_orders(id),
 submitted_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(), parameters JSONB
);
CREATE TABLE payment_commands (
 order_id UUID NOT NULL REFERENCES payment_orders(id), action TEXT NOT NULL,
 key TEXT NOT NULL, request_hash CHAR(64) NOT NULL, result JSONB,
 PRIMARY KEY(order_id,action,key)
);
CREATE TABLE payment_transactions (
 order_id UUID PRIMARY KEY REFERENCES payment_orders(id),
 provider_transaction_id TEXT NOT NULL UNIQUE,
 paid_at TIMESTAMPTZ(3) NOT NULL,
 amount INTEGER NOT NULL CHECK(amount=99900), currency TEXT NOT NULL CHECK(currency='CNY')
);
ALTER TABLE projects ADD COLUMN order_id UUID UNIQUE REFERENCES payment_orders(id);
ALTER TABLE projects ADD CONSTRAINT projects_order_id_id_unique UNIQUE(order_id,id);
CREATE TABLE project_subjects (
 id UUID PRIMARY KEY, project_id UUID NOT NULL UNIQUE REFERENCES projects(id), name TEXT
);
CREATE TABLE first_copy_entitlements (
 id UUID PRIMARY KEY, order_id UUID NOT NULL UNIQUE, project_id UUID NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'available' CHECK(state='available'),
 FOREIGN KEY(order_id,project_id) REFERENCES projects(order_id,id)
);
CREATE TABLE payment_inbox (
 event_id TEXT PRIMARY KEY, order_id UUID NOT NULL REFERENCES payment_orders(id),
 payload_hash CHAR(64) NOT NULL, verified_payment JSONB NOT NULL,
 verified_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ(3)
);
CREATE INDEX payment_inbox_unprocessed ON payment_inbox(processed_at);
CREATE TABLE project_service_terms (
 project_id UUID PRIMARY KEY REFERENCES projects(id),
 package_version_id UUID NOT NULL REFERENCES package_versions(id),
 policy JSONB NOT NULL, activated_at TIMESTAMPTZ(3) NOT NULL
);
CREATE FUNCTION protect_service_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Project service terms are immutable'; END $$;
CREATE TRIGGER immutable_service_terms BEFORE UPDATE ON project_service_terms FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TABLE project_service_events (
 project_id UUID NOT NULL REFERENCES project_service_terms(project_id),
 event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('subject_participation','delivery_completed','pause','resume')),
 occurred_at TIMESTAMPTZ(3) NOT NULL, support_case_ref TEXT, operator_id UUID,
 PRIMARY KEY(project_id,event_id)
);
CREATE UNIQUE INDEX project_service_fact_once ON project_service_events(project_id,kind) WHERE kind IN ('subject_participation','delivery_completed');
CREATE INDEX project_service_event_time ON project_service_events(project_id,occurred_at);
CREATE TRIGGER immutable_service_event BEFORE UPDATE ON project_service_events FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

-- Identity attribution includes the owning user, not merely a valid AppID/OpenID.
ALTER TABLE wechat_identities ADD CONSTRAINT wechat_identity_owner_unique UNIQUE(app_id,open_id,user_id);
ALTER TABLE payment_orders ADD CONSTRAINT payment_order_identity_owner FOREIGN KEY(app_id,open_id,buyer_id) REFERENCES wechat_identities(app_id,open_id,user_id);
CREATE TRIGGER immutable_payment_transaction BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
