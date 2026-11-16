import { z } from 'zod';
import { uuid } from './common';

export const webhookEventSchema = z.discriminatedUnion('type', [
  z.object({
    eventId: uuid,
    type: z.literal('payment.succeeded'),
    paymentId: uuid,
    orderId: uuid,
    amount: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
  z.object({
    eventId: uuid,
    type: z.literal('payment.failed'),
    paymentId: uuid,
    orderId: uuid,
    amount: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
  z.object({
    eventId: uuid,
    type: z.literal('refund.succeeded'),
    refundId: uuid,
    paymentId: uuid,
    orderId: uuid,
    amount: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const stubOutcomeSchema = z.object({
  outcome: z.enum(['success', 'failure', 'success_delayed']),
});
export type StubOutcome = z.infer<typeof stubOutcomeSchema>['outcome'];

export const payResponseSchema = z.object({ paymentId: uuid, url: z.string() });
export type PayResponse = z.infer<typeof payResponseSchema>;
