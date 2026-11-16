import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { cartItemPutSchema, productIdParam, promoApplySchema } from '@shop/shared';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { type SessionUser } from '../http/types';
import { ApiZBody } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';
import {
  acceptPrices,
  applyPromo,
  getCart,
  putCartItem,
  removeCartItem,
  removePromo,
} from './cart.logic';

@ApiTags('cart')
@Roles('customer')
@Controller('cart')
export class CartController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Get()
  get(@CurrentUser() u: SessionUser) {
    return getCart(this.ctx, u.id);
  }

  @Put('items/:productId')
  @ApiZBody(cartItemPutSchema)
  put(
    @CurrentUser() u: SessionUser,
    @Param(new ZodPipe(productIdParam)) p: z.infer<typeof productIdParam>,
    @Body(new ZodPipe(cartItemPutSchema)) body: z.infer<typeof cartItemPutSchema>,
  ) {
    return putCartItem(this.ctx, u.id, p.productId, body.qty);
  }

  @Delete('items/:productId')
  remove(
    @CurrentUser() u: SessionUser,
    @Param(new ZodPipe(productIdParam)) p: z.infer<typeof productIdParam>,
  ) {
    return removeCartItem(this.ctx, u.id, p.productId);
  }

  /** Customer confirms the current catalogue prices of everything in the cart. */
  @Post('accept-prices')
  @HttpCode(200)
  accept(@CurrentUser() u: SessionUser) {
    return acceptPrices(this.ctx, u.id);
  }

  @Post('promo')
  @HttpCode(200)
  @ApiZBody(promoApplySchema)
  promo(
    @CurrentUser() u: SessionUser,
    @Body(new ZodPipe(promoApplySchema)) body: z.infer<typeof promoApplySchema>,
  ) {
    return applyPromo(this.ctx, u.id, body.code);
  }

  @Delete('promo')
  deletePromo(@CurrentUser() u: SessionUser) {
    return removePromo(this.ctx, u.id);
  }
}
