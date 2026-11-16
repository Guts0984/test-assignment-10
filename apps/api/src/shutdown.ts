/**
 * Graceful shutdown, exactly once and in the right order: stop accepting requests and let the job
 * worker finish (app.close), THEN close the database pool, then exit 0.
 *
 * Do not combine this with Nest's enableShutdownHooks(): it re-sends the signal to the process after
 * its own cleanup, so a second handler ran and closed the pool twice ("Called end on pool more than
 * once", exit code 1 on every `docker stop`).
 */
export type ShutdownProcess = {
  on(signal: 'SIGTERM' | 'SIGINT', cb: () => void): unknown;
  exit(code: number): unknown;
};

export function installShutdown(
  app: { close(): Promise<void> },
  closeDb: () => Promise<void>,
  proc: ShutdownProcess = process,
  log: (msg: string) => void = (m) => console.error(m),
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return; // a second signal while stopping changes nothing
    stopping = true;
    app
      .close()
      .then(() => closeDb())
      .then(() => proc.exit(0))
      .catch((e: unknown) => {
        log(e instanceof Error ? e.message : String(e));
        proc.exit(1);
      });
  };
  proc.on('SIGTERM', stop);
  proc.on('SIGINT', stop);
}
