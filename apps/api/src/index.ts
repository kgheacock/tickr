import { runApi } from './roles/api.js';
import { runWorker } from './roles/worker.js';
import { runBot } from './roles/bot.js';

const ROLE = process.env['ROLE'] ?? 'api';

async function main(): Promise<void> {
  switch (ROLE) {
    case 'api':
      await runApi();
      return;
    case 'worker':
      await runWorker();
      return;
    case 'bot':
      await runBot();
      return;
    default:
      console.error(`unknown ROLE=${ROLE} (expected: api | worker | bot)`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
