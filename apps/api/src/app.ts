import { randomUUID } from 'node:crypto';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type NextFunction, type Response } from 'express';
import { buildAppModule } from './app.module';
import { type AppCtx } from './ctx';
import { getClientIp } from './http/client-ip';
import { type AppRequest } from './http/types';

export type CreateAppOptions = { ctx: AppCtx; extraModules?: Type<unknown>[]; logger?: false };

/** Builds the fully configured Nest app (also used by the tests, against a real socket). */
export async function createApp(opts: CreateAppOptions): Promise<INestApplication> {
  const { ctx } = opts;
  const app = await NestFactory.create<NestExpressApplication>(
    buildAppModule(ctx, opts.extraModules),
    {
      bodyParser: false,
      logger: opts.logger === false ? false : ['error', 'warn'],
    },
  );
  app.disable('x-powered-by');
  app.disable('etag');

  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    req.clientIp = getClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      ctx.env.TRUST_PROXY_HOPS,
    );
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // JSON only, small by default; raw bytes are kept for webhook signature verification
  app.useBodyParser('json', {
    limit: `${ctx.env.BODY_LIMIT_KB}kb`,
    verify: (req: AppRequest, _res: unknown, buf: Buffer) => {
      req.rawBody = buf;
    },
  });

  const config = new DocumentBuilder()
    .setTitle('Shop API')
    .setDescription(
      'Cart, checkout, orders, payments stub. Errors: { error: { code, message, details?, requestId } }.',
    )
    .setVersion('1.0')
    .addCookieAuth('sid')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
  });
  return app;
}
