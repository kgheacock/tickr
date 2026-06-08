import { runApi } from './roles/api.js';
import { runWorker } from './roles/worker.js';

const ROLE = process.env['ROLE'] ?? 'api';

async function main(): Promise<void> {
  switch (ROLE) {
    case 'api':
      await runApi();
      return;
    case 'worker':
      await runWorker();
      return;
    default:
      console.error(`unknown ROLE=${ROLE} (expected: api | worker)`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
