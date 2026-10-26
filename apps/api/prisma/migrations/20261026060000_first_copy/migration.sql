-- CreateTable
CREATE TABLE "first_copy_addresses" (
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "first_copy_addresses_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "book_confirmations" (
    "id" UUID NOT NULL,
    "sequence" SERIAL NOT NULL,
    "project_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "book_id" UUID NOT NULL,
    "snapshot_hash" CHAR(64) NOT NULL,
    "pdf_hash" CHAR(64) NOT NULL,
    "address_hash" CHAR(64),
    "address_version" INTEGER,
    "subject_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "binding_version" INTEGER NOT NULL,
    "access_epoch" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "assisted_evidence_id" UUID,
    "notice_version" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_copy_orders" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "entitlement_id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "snapshot_hash" CHAR(64) NOT NULL,
    "pdf_hash" CHAR(64) NOT NULL,
    "address_hash" CHAR(64) NOT NULL,
    "address" JSONB NOT NULL,
    "narrator_confirmation_id" UUID NOT NULL,
    "initiator_confirmation_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_copy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_copy_commands" (
    "project_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,

    CONSTRAINT "first_copy_commands_pkey" PRIMARY KEY ("project_id","actor_id","action","key")
);

-- CreateTable
CREATE TABLE "fulfillment_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_outbox" (
    "event_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "fulfillment_outbox_pkey" PRIMARY KEY ("event_id")
);


CREATE UNIQUE INDEX "book_confirmations_sequence_key" ON "book_confirmations"("sequence");
CREATE INDEX "book_confirmations_project_id_role_sequence_idx" ON "book_confirmations"("project_id", "role", "sequence");
CREATE UNIQUE INDEX "book_confirmations_project_id_evidence_ref_key" ON "book_confirmations"("project_id", "evidence_ref");
CREATE UNIQUE INDEX "first_copy_orders_project_id_key" ON "first_copy_orders"("project_id");
CREATE UNIQUE INDEX "first_copy_orders_entitlement_id_key" ON "first_copy_orders"("entitlement_id");
CREATE UNIQUE INDEX "first_copy_orders_payment_order_id_key" ON "first_copy_orders"("payment_order_id");
CREATE UNIQUE INDEX "fulfillment_events_order_id_kind_key" ON "fulfillment_events"("order_id", "kind");

ALTER TABLE first_copy_entitlements DROP CONSTRAINT first_copy_entitlements_state_check;
ALTER TABLE first_copy_entitlements ADD CONSTRAINT first_copy_entitlements_state_check CHECK(state IN ('available','reserved','suspended','revoked'));
ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CONSTRAINT care_requests_kind_check CHECK(kind IN ('rebind','withdraw','export','delete','correction','first_copy_expiry'));
CREATE UNIQUE INDEX first_copy_expiry_once ON care_requests(project_id) WHERE kind='first_copy_expiry';
ALTER TABLE first_copy_addresses ADD FOREIGN KEY(project_id) REFERENCES projects(id), ADD CHECK(version>0);
ALTER TABLE book_confirmations ADD FOREIGN KEY(project_id,book_id) REFERENCES book_versions(project_id,id), ADD FOREIGN KEY(subject_id) REFERENCES project_subjects(id), ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD FOREIGN KEY(assisted_evidence_id) REFERENCES assisted_version_evidence(id), ADD CHECK(role IN ('narrator','initiator')), ADD CHECK((role='narrator' AND address_hash IS NULL AND address_version IS NULL) OR (role='initiator' AND address_hash IS NOT NULL AND address_version > 0));
ALTER TABLE first_copy_orders ADD FOREIGN KEY(entitlement_id) REFERENCES first_copy_entitlements(id), ADD FOREIGN KEY(payment_order_id,project_id) REFERENCES projects(order_id,id), ADD FOREIGN KEY(project_id,book_id) REFERENCES book_versions(project_id,id), ADD FOREIGN KEY(narrator_confirmation_id) REFERENCES book_confirmations(id), ADD FOREIGN KEY(initiator_confirmation_id) REFERENCES book_confirmations(id), ADD CHECK(state IN ('reserved','approved'));
ALTER TABLE first_copy_commands ADD FOREIGN KEY(project_id) REFERENCES projects(id);
ALTER TABLE fulfillment_events ADD FOREIGN KEY(order_id) REFERENCES first_copy_orders(id), ADD CHECK(kind IN ('reserved','approved'));
ALTER TABLE fulfillment_outbox ADD FOREIGN KEY(event_id) REFERENCES fulfillment_events(id);
CREATE TRIGGER immutable_book_confirmation BEFORE UPDATE ON book_confirmations FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_fulfillment_event BEFORE UPDATE ON fulfillment_events FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE FUNCTION protect_first_copy_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'approved_by'-'approved_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'approved_by'-'approved_at') OR (OLD.state='approved' AND NEW.state<>'approved') THEN RAISE EXCEPTION 'First copy binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_first_copy_binding BEFORE UPDATE ON first_copy_orders FOR EACH ROW EXECUTE FUNCTION protect_first_copy_binding();
