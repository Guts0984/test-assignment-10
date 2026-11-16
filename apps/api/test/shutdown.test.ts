import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdown, type ShutdownProcess } from '../src/shutdown';

function fakeProcess() {
  const ee = new EventEmitter();
  const exit = vi.fn();
  const proc: ShutdownProcess = {
    on: (sig, cb) => ee.on(sig, cb),
    exit,
  };
  return { ee, exit, proc };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('graceful shutdown', () => {
  it('SIGTERM: closes the app, THEN the database, once, and exits 0', async () => {
    const order: string[] = [];
    const { ee, exit, proc } = fakeProcess();
    installShutdown(
      { close: async () => void order.push('app') },
      async () => void order.push('db'),
      proc,
    );
    ee.emit('SIGTERM');
    await tick();
    expect(order).toEqual(['app', 'db']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('repeated or mixed signals while stopping (docker + Nest re-sending SIGTERM) close the pool ONCE', async () => {
    const closeDb = vi.fn(async () => undefined);
    const closeApp = vi.fn(async () => undefined);
    const { ee, exit, proc } = fakeProcess();
    installShutdown({ close: closeApp }, closeDb, proc);
    ee.emit('SIGTERM');
    ee.emit('SIGTERM');
    ee.emit('SIGINT');
    await tick();
    expect(closeApp).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('a failure while stopping is logged and exits 1 (not silently 0), without closing twice', async () => {
    const log = vi.fn();
    const { ee, exit, proc } = fakeProcess();
    installShutdown(
      { close: async () => Promise.reject(new Error('boom')) },
      async () => undefined,
      proc,
      log,
    );
    ee.emit('SIGTERM');
    await tick();
    expect(log).toHaveBeenCalledWith('boom');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
