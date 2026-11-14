ALTER TABLE payment_orders ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_mode_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_mode_check CHECK (mode IN ('local-verification','wechat','alipay','channel'));
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_provider_binding;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_provider_binding CHECK (
 (provider='wechat' AND app_id IS NOT NULL AND open_id IS NOT NULL AND merchant_id IS NOT NULL AND mode IN ('local-verification','wechat') AND channel IS NULL)
 OR (provider='alipay' AND app_id IS NULL AND open_id IS NULL AND merchant_id IS NULL AND mode='alipay' AND channel IN ('alipay_page','alipay_wap'))
 OR (provider='channel' AND app_id IS NULL AND open_id IS NULL AND merchant_id IS NULL AND mode='channel' AND channel='manual' AND state='paid' AND NOT is_e2e)
);
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_amount_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_amount_check CHECK (
 (provider='channel' AND (amount IS NULL OR amount>=0)) OR
 (provider<>'channel' AND amount IS NOT NULL AND ((is_e2e AND amount=1 AND mode IN ('wechat','alipay')) OR (NOT is_e2e AND amount=99900)))
);
