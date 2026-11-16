import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CTX, type AppCtx } from '../ctx';
import { runDueJobs, runMaintenance } from './worker';

/** Polls the PostgreSQL job table. Several api instances can run it at once (SKIP LOCKED). */
@Injectable()
export class JobsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Jobs');
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private lastMaintenance = 0;

  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  onApplicationBootstrap(): void {
    if (!this.ctx.env.JOBS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.ctx.env.JOBS_POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while ((await runDueJobs(this.ctx)) > 0) {
        /* drain */
      }
      if (Date.now() - this.lastMaintenance > 10 * 60_000) {
        this.lastMaintenance = Date.now();
        await runMaintenance(this.ctx);
      }
    } catch (e) {
      this.log.error(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }
}

@Module({ providers: [JobsRunner] })
export class JobsModule {}
