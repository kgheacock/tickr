/**
 * Functional end-to-end test — Fantasy Street inline team rename.
 *
 * Drives the real web UI in headless Chromium against a running dev stack
 * (default http://localhost:5173 — start it with `pnpm dev`). It exercises the
 * masthead's inline rename affordance on a league dashboard:
 *
 *   1. Dev-logs in an admin (`?login=true`), who creates a league and so becomes
 *      its commissioner + first member, landing on the league dashboard. The
 *      masthead wordmark is the admin's own team ("The Dip Buyers").
 *   2. Clicks the pencil, types a new name, and saves with the checkmark — the
 *      wordmark updates in place.
 *   3. Reloads the dashboard and confirms the new name is still shown, proving
 *      the rename persisted to the backend (a manager renaming their OWN team,
 *      not via the commissioner-only path).
 *   4. Opens the editor again, types a throwaway name, and discards with the ×;
 *      the wordmark keeps the saved name and the field closes.
 *   5. Teardown: the admin deletes the league from the homepage.
 *
 * Only the `playwright` library is a dependency (no `@playwright/test` runner),
 * so assertions are plain throws and the process exits non-zero on the first
 * failure. Run: `pnpm --filter @tickr/web run e2e:rename` (override the target
 * with `BASE_URL=…`).
 *
 * Relies on the dev-only auth backdoor (TICKR_DEV_AUTH=1, set by the dev compose
 * overlay) and `import.meta.env.DEV` (true under the vite dev server). It never
 * runs against production — the backdoor is absent there.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const TIMEOUT = 30_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const freshEmail = () => `test_${randomUUID()}@gmail.com`;

/**
 * Open a page in a fresh context and dev-login as an admin through the UI
 * (`?login=true`), waiting until `/me` resolves the signed-in view.
 */
async function signInAdmin(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const params = new URLSearchParams({ login: 'true', email });
  await page.goto(`${BASE_URL}/?${params.toString()}`);
  // "Sign out" renders for any signed-in user (off the same `/me` the rest of
  // the UI reads), so it's a reliable marker the dev-login round trip finished.
  await page
    .getByRole('button', { name: 'Sign out' })
    .waitFor({ state: 'visible', timeout: TIMEOUT });
  return page;
}

/**
 * Admin opens the create-league modal, names the league + their team, and
 * submits (no invitees — solo league is enough to reach the dashboard). Returns
 * the new league's id, read off the dashboard URL it navigates to.
 */
async function createLeague(
  page: Page,
  leagueName: string,
  teamName: string,
): Promise<string> {
  await page.getByRole('button', { name: 'Start a League' }).click();
  await page
    .getByRole('dialog')
    .waitFor({ state: 'visible', timeout: TIMEOUT });

  await page.getByLabel('League name').fill(leagueName);
  await page.getByLabel('Your team').fill(teamName);

  await page.getByRole('button', { name: 'Start League', exact: true }).click();
  await page.waitForURL(/\/leagues\/[0-9a-fA-F-]+$/, { timeout: TIMEOUT });
  const id = page.url().split('/').pop()!;
  assert(id, 'expected a league id in the dashboard URL');
  return id;
}

/** The masthead wordmark, addressed by its heading role + accessible name. */
function wordmark(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true });
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  let page: Page | undefined;
  try {
    const leagueName = `E2E Rename ${randomUUID().slice(0, 8)}`;
    const initialTeam = 'The Dip Buyers';
    const renamedTeam = `Diamond Hands ${randomUUID().slice(0, 8)}`;
    const throwaway = 'SHOULD NOT PERSIST';

    // 1) Admin signs in and creates a league → lands on the dashboard.
    console.log('1) admin dev-login + create league…');
    page = await signInAdmin(browser, freshEmail());
    const leagueId = await createLeague(page, leagueName, initialTeam);
    console.log(`   league created: ${leagueId}`);
    await wordmark(page, initialTeam).waitFor({
      state: 'visible',
      timeout: TIMEOUT,
    });

    // 2) Rename: pencil → field → checkmark. The wordmark updates in place.
    console.log(`2) renaming "${initialTeam}" → "${renamedTeam}"…`);
    await page.getByRole('button', { name: 'Rename team' }).click();
    const field = page.getByLabel('Team name');
    await field.waitFor({ state: 'visible', timeout: TIMEOUT });
    await field.fill(renamedTeam);
    await page.getByRole('button', { name: 'Save team name' }).click();
    await wordmark(page, renamedTeam).waitFor({
      state: 'visible',
      timeout: TIMEOUT,
    });
    console.log('   ✓ wordmark shows the new name');

    // 3) Reload — the new name survives a fresh fetch, so it persisted.
    console.log('3) reloading to confirm the rename persisted…');
    await page.reload();
    await wordmark(page, renamedTeam).waitFor({
      state: 'visible',
      timeout: TIMEOUT,
    });
    console.log('   ✓ persisted across reload');

    // 4) Discard: pencil → type → × leaves the saved name untouched.
    console.log('4) editing then discarding with the ×…');
    await page.getByRole('button', { name: 'Rename team' }).click();
    const field2 = page.getByLabel('Team name');
    await field2.waitFor({ state: 'visible', timeout: TIMEOUT });
    await field2.fill(throwaway);
    await page
      .getByRole('button', { name: 'Discard team name change' })
      .click();
    // The field closes and the saved name is unchanged.
    await field2.waitFor({ state: 'detached', timeout: TIMEOUT });
    await wordmark(page, renamedTeam).waitFor({
      state: 'visible',
      timeout: TIMEOUT,
    });
    const throwawayShown = await wordmark(page, throwaway).count();
    assert(
      throwawayShown === 0,
      'discarded name must not appear in the masthead',
    );
    console.log('   ✓ discard kept the saved name');

    // 5) Teardown: delete the league from the homepage.
    console.log('5) deleting the league…');
    await page.goto(`${BASE_URL}/`);
    await page.getByRole('button', { name: `Delete ${leagueName}` }).click();
    await page
      .getByRole('dialog')
      .waitFor({ state: 'visible', timeout: TIMEOUT });
    await page
      .getByRole('button', { name: 'Delete league', exact: true })
      .click();
    await page
      .getByRole('link', { name: leagueName })
      .waitFor({ state: 'detached', timeout: TIMEOUT });
    console.log('   ✓ league deleted');

    console.log('\nPASS — rename → persist → discard all verified.');
  } finally {
    if (page) await page.context().close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\nFAIL —', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
