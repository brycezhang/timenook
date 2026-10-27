-- An older quality grant must not revive after a same-epoch assisted refusal.
-- Unknown historical captures remain conservatively fenced by sequence zero.
ALTER TABLE quality_grants ADD COLUMN access_sequence integer NOT NULL DEFAULT 0 CHECK(access_sequence>=0);
