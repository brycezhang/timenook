ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_mode_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_mode_check
  CHECK (mode IN ('local-verification', 'wechat'));
