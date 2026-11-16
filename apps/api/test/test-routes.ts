import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public, Roles } from '../src/auth/decorators';
import { ZodPipe } from '../src/http/zod.pipe';

const echo = z.object({ n: z.number().int().min(0).max(100), s: z.string().max(10).optional() });

/** Routes that exist only in tests: they prove the guards without depending on business modules. */
@Controller('test')
export class TestRoutesController {
  @Roles('manager')
  @Get('manager-only')
  managerOnly() {
    return { ok: true };
  }

  @Roles('customer')
  @Get('customer-only')
  customerOnly() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  pub() {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('SECRET internal detail: password=hunter2 at /srv/app/db.ts');
  }

  @Public()
  @Post('echo')
  echo(@Body(new ZodPipe(echo)) body: z.infer<typeof echo>) {
    return body;
  }
}

@Module({ controllers: [TestRoutesController] })
export class TestRoutesModule {}
