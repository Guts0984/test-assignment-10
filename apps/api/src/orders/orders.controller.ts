import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import {
  idempotencyKeySchema,
  idParam,
  orderCreateSchema,
  orderListQuerySchema,
  returnCreateSchema,
  statusPatchSchema,
  type OrderCreate,
  type OrderListQuery,
  type ReturnCreate,
} from '@shop/shared';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { badRequest } from '../http/errors';
import { type SessionUser } from '../http/types';
import { ApiZBody, ApiZQuery } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';
import { createOrder } from './checkout';
import { cancelOrder, changeStatus, createReturn } from './lifecycle';
import { getOrderFor, listOrders } from './orders.logic';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  /** `Idempotency-Key: <uuid made by the client>`: a double click or a retry after a dropped connection returns the SAME order. */
  @Roles('customer')
  @Post()
  @ApiZBody(orderCreateSchema)
  async create(
    @CurrentUser() u: SessionUser,
    @Body(new ZodPipe(orderCreateSchema)) body: OrderCreate,
    @Headers('idempotency-key') header: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeySchema.safeParse(header ?? body.idempotencyKey);
    if (!key.success)
      throw badRequest('A valid Idempotency-Key (UUID) header is required', [
        { path: 'Idempotency-Key', message: 'required UUID' },
      ]);
    const r = await createOrder(this.ctx, u.id, body, key.data);
    res.status(r.created ? 201 : 200);
    return r.order;
  }

  @Get()
  @ApiZQuery(orderListQuerySchema)
  list(@CurrentUser() u: SessionUser, @Query(new ZodPipe(orderListQuerySchema)) q: OrderListQuery) {
    return listOrders(this.ctx, u, q);
  }

  @Get(':id')
  get(@CurrentUser() u: SessionUser, @Param(new ZodPipe(idParam)) p: { id: string }) {
    return getOrderFor(this.ctx, u, p.id);
  }

  @Roles('customer')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: SessionUser, @Param(new ZodPipe(idParam)) p: { id: string }) {
    return cancelOrder(this.ctx, p.id, u.id);
  }

  @Roles('customer')
  @Post(':id/returns')
  @ApiZBody(returnCreateSchema)
  returns(
    @CurrentUser() u: SessionUser,
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(returnCreateSchema)) body: ReturnCreate,
  ) {
    return createReturn(this.ctx, p.id, u.id, body);
  }

  @Roles('manager')
  @Patch(':id/status')
  @ApiZBody(statusPatchSchema)
  status(
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(statusPatchSchema)) body: z.infer<typeof statusPatchSchema>,
  ) {
    return changeStatus(this.ctx, p.id, body.status);
  }
}
