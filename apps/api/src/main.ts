import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createDbHandle } from '@shop/db';
import { createApp } from './app';
import { systemClock } from './ctx';
import { parseEnv } from './env';
import { installShutdown } from './shutdown';

async function bootstrap(): Promise<void> {
  const env = parseEnv();
  const { db, close } = createDbHandle(env.DATABASE_URL);
  const app = await createApp({ ctx: { db, env, clock: systemClock } });
  await app.listen(env.API_PORT, env.API_HOST);
  new Logger('Bootstrap').log(`api listening on :${env.API_PORT}`);
  installShutdown(app, close);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
