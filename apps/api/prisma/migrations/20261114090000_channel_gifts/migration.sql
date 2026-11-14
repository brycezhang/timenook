CREATE TABLE channel_gifts (
 id uuid PRIMARY KEY,
 internal_number text NOT NULL UNIQUE,
 operator_id uuid NOT NULL REFERENCES admin_accounts(id),
 idempotency_key text NOT NULL,
 request_hash char(64) NOT NULL,
 buyer_phone varchar(32) NOT NULL,
 buyer_id uuid REFERENCES users(id),
 package_version_id uuid NOT NULL REFERENCES package_versions(id),
 package_snapshot jsonb NOT NULL,
 package_title text NOT NULL,
 list_amount integer NOT NULL CHECK (list_amount >= 0),
 paid_amount integer CHECK (paid_amount >= 0),
 paid_at timestamptz(3),
 external_order_no text,
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'void')),
 project_id uuid UNIQUE REFERENCES projects(id),
 order_id uuid UNIQUE REFERENCES payment_orders(id),
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 associated_at timestamptz(3),
 reminder_handled_by uuid REFERENCES users(id),
 reminder_handled_at timestamptz(3),
 UNIQUE(operator_id, idempotency_key)
);
CREATE INDEX channel_gifts_phone_state ON channel_gifts(buyer_phone,state);
CREATE INDEX channel_gifts_buyer_created ON channel_gifts(buyer_id,created_at);
