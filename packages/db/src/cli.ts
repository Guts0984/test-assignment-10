import { createDbHandle } from './client';
import { runMigrations } from './migrate';
import { isSeeded, seedDatabase } from './seed';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const handle = createDbHandle(required('DATABASE_URL'), { max: 5 });
  try {
    if (cmd === 'migrate' || cmd === 'bootstrap') {
      await runMigrations(handle.db);
      console.log('migrations applied');
    }
    if (cmd === 'seed' || cmd === 'bootstrap') {
      if (cmd === 'bootstrap' && process.env.RUN_SEED === 'false') {
        console.log('seed disabled (RUN_SEED=false)');
      } else if (await isSeeded(handle.db)) {
        console.log('database already has data: seed skipped');
      } else {
        const started = Date.now();
        const s = await seedDatabase(handle.db, {
          managerPassword: required('SEED_MANAGER_PASSWORD'),
          customerPassword: required('SEED_CUSTOMER_PASSWORD'),
        });
        console.log(`seeded ${JSON.stringify(s)} in ${Date.now() - started} ms`);
      }
    }
    if (!['migrate', 'seed', 'bootstrap'].includes(cmd ?? '')) {
      throw new Error('usage: cli.js migrate | seed | bootstrap');
    }
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
