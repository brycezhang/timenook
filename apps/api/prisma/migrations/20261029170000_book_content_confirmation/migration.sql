-- PDF content review is independent of payment, shipping address and first-copy reservation.
ALTER TABLE book_confirmations DROP CONSTRAINT book_confirmations_check;
ALTER TABLE book_confirmations ADD CONSTRAINT book_confirmations_address_check CHECK (
 (address_hash IS NULL AND address_version IS NULL) OR
 (role='initiator' AND address_hash IS NOT NULL AND address_version > 0)
);
