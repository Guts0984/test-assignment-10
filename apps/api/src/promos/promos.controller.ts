import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  idParam,
  promoCreateSchema,
  promoUpdateSchema,
  type PromoCreate,
  type PromoUpdate,
} from '@shop/shared';
import { Roles } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { ApiZBody } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';
import { createPromo, deletePromo, getPromo, listPromos, updatePromo } from './promos.logic';

@ApiTags('promos')
@Roles('manager')
@Controller('promos')
export class PromosController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Get()
  list() {
    return listPromos(this.ctx);
  }

  @Get(':id')
  get(@Param(new ZodPipe(idParam)) p: { id: string }) {
    return getPromo(this.ctx, p.id);
  }

  @Post()
  @ApiZBody(promoCreateSchema)
  create(@Body(new ZodPipe(promoCreateSchema)) body: PromoCreate) {
    return createPromo(this.ctx, body);
  }

  @Patch(':id')
  @ApiZBody(promoUpdateSchema)
  update(
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(promoUpdateSchema)) body: PromoUpdate,
  ) {
    return updatePromo(this.ctx, p.id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param(new ZodPipe(idParam)) p: { id: string }): Promise<void> {
    await deletePromo(this.ctx, p.id);
  }
}
