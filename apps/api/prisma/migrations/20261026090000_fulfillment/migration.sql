-- CreateTable
CREATE TABLE "fulfillment_attempts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "handoff_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "owner_admin_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "supplier_ref" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'approved',
    "receipt_ref" TEXT,
    "tracking" JSONB,
    "wechat" JSONB,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_grants" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "access_epoch" INTEGER NOT NULL,
    "binding_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "notice_version" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_commands" (
    "project_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "attempt_id" UUID,

    CONSTRAINT "fulfillment_commands_pkey" PRIMARY KEY ("project_id","actor_id","action","key")
);

-- CreateTable
CREATE TABLE "fulfillment_deliveries" (
    "order_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "operator_admin_id" UUID NOT NULL,

    CONSTRAINT "fulfillment_deliveries_pkey" PRIMARY KEY ("order_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_handoff_id_key" ON "fulfillment_attempts"("handoff_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_case_id_key" ON "fulfillment_attempts"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_order_id_sequence_key" ON "fulfillment_attempts"("order_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_project_id_id_key" ON "fulfillment_attempts"("project_id", "id");

-- CreateIndex
CREATE INDEX "fulfillment_grants_attempt_id_created_at_idx" ON "fulfillment_grants"("attempt_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_deliveries_attempt_id_key" ON "fulfillment_deliveries"("attempt_id");

ALTER TABLE first_copy_entitlements DROP CONSTRAINT first_copy_entitlements_state_check;
ALTER TABLE first_copy_entitlements ADD CONSTRAINT first_copy_entitlements_state_check CHECK(state IN ('available','reserved','consumed','suspended','revoked'));
ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CONSTRAINT care_requests_kind_check CHECK(kind IN ('rebind','withdraw','export','delete','correction','production_handoff'));
CREATE UNIQUE INDEX first_copy_orders_project_id_id_key ON first_copy_orders(project_id,id);
ALTER TABLE fulfillment_attempts ADD FOREIGN KEY(project_id,order_id) REFERENCES first_copy_orders(project_id,id), ADD FOREIGN KEY(case_id) REFERENCES care_requests(id), ADD FOREIGN KEY(owner_admin_id) REFERENCES admin_accounts(id), ADD CHECK(sequence>0), ADD CHECK(state IN ('approved','handoff_pending','in_production','shipped','delivered','cancellation_pending','cancelled'));
CREATE UNIQUE INDEX one_live_fulfillment_attempt ON fulfillment_attempts(order_id) WHERE state <> 'cancelled';
ALTER TABLE fulfillment_grants ADD FOREIGN KEY(project_id,attempt_id) REFERENCES fulfillment_attempts(project_id,id), ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD FOREIGN KEY(subject_id) REFERENCES project_subjects(id);
ALTER TABLE fulfillment_commands ADD FOREIGN KEY(project_id) REFERENCES projects(id), ADD FOREIGN KEY(project_id,attempt_id) REFERENCES fulfillment_attempts(project_id,id);
ALTER TABLE fulfillment_deliveries ADD FOREIGN KEY(order_id) REFERENCES first_copy_orders(id), ADD FOREIGN KEY(attempt_id) REFERENCES fulfillment_attempts(id), ADD FOREIGN KEY(operator_admin_id) REFERENCES admin_accounts(id);
CREATE TRIGGER immutable_fulfillment_grant BEFORE UPDATE ON fulfillment_grants FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_fulfillment_delivery BEFORE UPDATE ON fulfillment_deliveries FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

ALTER TABLE fulfillment_grants ADD COLUMN sequence SERIAL NOT NULL UNIQUE;
CREATE TABLE fulfillment_records(id UUID PRIMARY KEY,attempt_id UUID NOT NULL REFERENCES fulfillment_attempts(id),kind TEXT NOT NULL,evidence JSONB NOT NULL,operator_admin_id UUID NOT NULL REFERENCES admin_accounts(id),created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER immutable_fulfillment_record BEFORE UPDATE ON fulfillment_records FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

CREATE UNIQUE INDEX fulfillment_attempts_order_id_id_key ON fulfillment_attempts(order_id,id);
ALTER TABLE fulfillment_deliveries ADD FOREIGN KEY(order_id,attempt_id) REFERENCES fulfillment_attempts(order_id,id);
