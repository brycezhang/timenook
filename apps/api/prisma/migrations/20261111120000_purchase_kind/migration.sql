-- Development schema update. Existing development data is rebuilt, not inferred
-- from mutable relationship labels. The existing immutable snapshot trigger
-- automatically protects purchase_kind together with the other order facts.
ALTER TABLE payment_orders ADD COLUMN purchase_kind text NOT NULL
  CHECK (purchase_kind IN ('self', 'gift'));
