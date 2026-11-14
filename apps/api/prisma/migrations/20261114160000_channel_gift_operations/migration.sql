CREATE TABLE channel_gift_operations (
 id uuid PRIMARY KEY,
 gift_id uuid NOT NULL REFERENCES channel_gifts(id),
 operator_id uuid NOT NULL REFERENCES admin_accounts(id),
 action text NOT NULL CHECK (action IN ('correct', 'void')),
 reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
 before_phone varchar(32) NOT NULL,
 after_phone varchar(32) NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX channel_gift_operations_gift_created ON channel_gift_operations(gift_id,created_at);
