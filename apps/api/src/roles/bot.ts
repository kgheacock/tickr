export async function runBot(): Promise<void> {
  console.log('[bot] started — no bots registered yet');
  // Keep the process alive until item 07 wires the index bot in.
  await new Promise<never>(() => {
    /* never resolves */
  });
}
