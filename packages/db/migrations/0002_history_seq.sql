DROP INDEX "order_events_order_idx";--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","seq");