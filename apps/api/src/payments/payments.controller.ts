import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  idParam,
  payBodySchema,
  stubOutcomeSchema,
  webhookEventSchema,
  type StubOutcome,
} from '@shop/shared';
import { z } from 'zod';
import { CurrentUser, Public, Roles, SkipOriginCheck, SkipRateLimit } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { AppError } from '../http/errors';
import { type AppRequest, type SessionUser } from '../http/types';
import { ApiZBody } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';
import { consume } from '../rate-limit/rate-limit';
import { SIGNATURE_HEADER, verifySignature } from './signature';
import { completeStubPayment, getStubSession, startPayment } from './stub';
import { processWebhook } from './webhook';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Roles('customer')
  @Post('orders/:id/pay')
  @HttpCode(200)
  @ApiZBody(payBodySchema)
  pay(
    @CurrentUser() u: SessionUser,
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(payBodySchema)) body: z.infer<typeof payBodySchema>,
  ) {
    return startPayment(this.ctx, p.id, u.id, body.returnUrl);
  }

  /**
   * Notifications from the payment provider (our stub). Server-to-server: no session, no Origin.
   * The signature is checked over the raw bytes BEFORE anything is parsed; failures are throttled per IP.
   */
  @Public()
  @SkipRateLimit()
  @SkipOriginCheck()
  @Post('payments/webhook')
  @HttpCode(200)
  async webhook(@Req() req: AppRequest) {
    const { env, clock } = this.ctx;
    const ok = verifySignature(
      env.WEBHOOK_SECRET,
      req.headers[SIGNATURE_HEADER],
      req.rawBody,
      clock.now(),
      env.WEBHOOK_TOLERANCE_SECONDS,
    );
    if (!ok) {
      const r = await consume(this.ctx, `webhook:badsig:${req.clientIp}`, {
        windowSeconds: 60,
        max: env.WEBHOOK_BAD_SIGNATURE_MAX_PER_MINUTE,
      });
      if (!r.allowed)
        throw new AppError(
          429,
          'rate_limited',
          'Too many invalid webhook signatures',
          { retryAfterSec: r.retryAfterSec },
          { 'Retry-After': String(r.retryAfterSec) },
        );
      throw new AppError(401, 'bad_signature', 'Invalid or missing signature');
    }
    const parsed = webhookEventSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        'validation_error',
        'Invalid event',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return processWebhook(this.ctx, parsed.data);
  }

  /** The stub's own page asks what it is paying for ... */
  @Public()
  @Get('stub/payments/:id')
  session(@Param(new ZodPipe(idParam)) p: { id: string }) {
    return getStubSession(this.ctx, p.id);
  }

  /** ... and reports the (fake) card result back. The unguessable payment id is the capability. */
  @Public()
  @Post('stub/payments/:id/complete')
  @HttpCode(200)
  @ApiZBody(stubOutcomeSchema)
  complete(
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(stubOutcomeSchema)) body: { outcome: StubOutcome },
  ) {
    return completeStubPayment(this.ctx, p.id, body.outcome);
  }
}
