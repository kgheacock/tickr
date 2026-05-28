export async function runWorker(): Promise<void> {
  console.log('[worker] started — no scheduled jobs registered yet');
  // Keep the process alive until item 06 wires real jobs in.
  await new Promise<never>(() => {
    /* never resolves */
  });
}
