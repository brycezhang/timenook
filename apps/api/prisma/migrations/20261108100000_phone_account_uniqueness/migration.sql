-- Canonicalize currently stored verified mainland phone numbers; never merge owners.
UPDATE users SET phone_number = '+86' || phone_number
WHERE phone_number ~ '^1[3-9][0-9]{9}$';
UPDATE users SET phone_number = '+' || phone_number
WHERE phone_number ~ '^861[3-9][0-9]{9}$';
CREATE UNIQUE INDEX users_phone_number_key ON users(phone_number);
