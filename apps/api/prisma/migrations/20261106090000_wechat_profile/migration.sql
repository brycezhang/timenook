ALTER TABLE "users" ADD COLUMN "nickname" VARCHAR(32), ADD COLUMN "phone_number" VARCHAR(32);
ALTER TABLE "users" ADD CONSTRAINT "user_nickname_nonempty" CHECK ("nickname" IS NULL OR length(trim("nickname")) BETWEEN 1 AND 32);
