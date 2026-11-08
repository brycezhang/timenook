ALTER TABLE payment_orders ALTER COLUMN app_id DROP NOT NULL, ALTER COLUMN open_id DROP NOT NULL, ALTER COLUMN merchant_id DROP NOT NULL;
ALTER TABLE payment_orders ADD COLUMN provider text NOT NULL DEFAULT 'wechat', ADD COLUMN channel text;
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_mode_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_mode_check CHECK (mode IN ('local-verification','wechat','alipay'));
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_provider_binding CHECK (
 (provider='wechat' AND app_id IS NOT NULL AND open_id IS NOT NULL AND merchant_id IS NOT NULL AND mode IN ('local-verification','wechat') AND channel IS NULL)
 OR (provider='alipay' AND app_id IS NULL AND open_id IS NULL AND merchant_id IS NULL AND mode='alipay' AND channel IS NOT NULL AND channel IN ('alipay_page','alipay_wap') )
);
ALTER TABLE payment_submissions ADD COLUMN remote_order_no text UNIQUE;
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_amount_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_amount_check CHECK ((is_e2e AND amount=1 AND mode IN ('wechat','alipay')) OR (NOT is_e2e AND amount=99900));
