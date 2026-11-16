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
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  idParam,
  productCreateSchema,
  productQuerySchema,
  productUpdateSchema,
  type ProductCreate,
  type ProductQuery,
  type ProductUpdate,
} from '@shop/shared';
import { Public, Roles } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { type AppRequest } from '../http/types';
import { ApiZBody, ApiZQuery } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';
import {
  createProduct,
  deactivateProduct,
  getProduct,
  listCategories,
  listProducts,
  updateProduct,
} from './products.logic';

@ApiTags('products')
@Controller()
export class ProductsController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Public()
  @Get('categories')
  categories() {
    return listCategories(this.ctx);
  }

  @Public()
  @Get('products')
  @ApiZQuery(productQuerySchema)
  list(@Query(new ZodPipe(productQuerySchema)) q: ProductQuery, @Req() req: AppRequest) {
    return listProducts(this.ctx, q, { canSeeInactive: req.user?.role === 'manager' });
  }

  @Public()
  @Get('products/:id')
  get(@Param(new ZodPipe(idParam)) p: { id: string }, @Req() req: AppRequest) {
    return getProduct(this.ctx, p.id, { canSeeInactive: req.user?.role === 'manager' });
  }

  @Roles('manager')
  @Post('products')
  @ApiZBody(productCreateSchema)
  create(@Body(new ZodPipe(productCreateSchema)) body: ProductCreate) {
    return createProduct(this.ctx, body);
  }

  @Roles('manager')
  @Patch('products/:id')
  @ApiZBody(productUpdateSchema)
  update(
    @Param(new ZodPipe(idParam)) p: { id: string },
    @Body(new ZodPipe(productUpdateSchema)) body: ProductUpdate,
  ) {
    return updateProduct(this.ctx, p.id, body);
  }

  @Roles('manager')
  @Delete('products/:id')
  @HttpCode(204)
  async remove(@Param(new ZodPipe(idParam)) p: { id: string }): Promise<void> {
    await deactivateProduct(this.ctx, p.id);
  }
}
