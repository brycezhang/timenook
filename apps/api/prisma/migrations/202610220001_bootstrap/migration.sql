CREATE TABLE "service_schema" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "revision" INTEGER NOT NULL CHECK ("revision" > 0)
);
INSERT INTO "service_schema" ("id", "revision") VALUES (1, 1);
