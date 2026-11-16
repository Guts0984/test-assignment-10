-- First order will be ORD-10234.
INSERT INTO "order_counter" ("id", "last") VALUES (1, 10233) ON CONFLICT ("id") DO NOTHING;
