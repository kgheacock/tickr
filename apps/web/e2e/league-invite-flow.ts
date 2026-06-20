/**
 * Functional end-to-end test — Fantasy Street create → invite → auto-join.
 *
 * Drives the real web UI in headless Chromium against a running dev stack
 * (default http://localhost:5173 — start it with `pnpm dev`). It:
 *
 *   1. Creates 3 accounts via the dev-login backdoor (`?login=true`): one admin
 *      and two regular players, each `test_<uuid>@gmail.com`, each in its own
 *      browser context so their sessions don't collide. The regulars are
 *      created first so their accounts exist when the admin invites them. A
 *      fourth invitee email is held back and never signed in beforehand.
 *   2. The admin opens the "Start a League" modal and creates a league, inviting
 *      the two existing regulars plus the never-signed-in pending email.
 *   3. Each regular loads their homepage and verifies the league is listed —
 *      invited humans with an existing account are auto-joined as managers (see
 *      createLeague in apps/api/src/fantasy/leagues.ts).
 *   4. The pending invitee signs in for the first time and verifies the league is
 *      already waiting on their homepage — the create flow pre-created an
 *      unclaimed account for the unknown email and seated it as a real manager,
 *      and first sign-in claims it via the verified-email merge (no join step).
 *   5. Teardown: the admin deletes the league from the homepage.
 *
 * Only the `playwright` library is a dependency (no `@playwright/test` runner),
 * so assertions are plain throws and the process exits non-zero on the first
 * failure. Run: `pnpm --filter @tickr/web run e2e` (override the target with
 * `BASE_URL=…`).
 *
 * Relies on the dev-only auth backdoor (TICKR_DEV_AUTH=1, set by the dev compose
 * overlay) and `import.meta.env.DEV` (true under the vite dev server). It never
 * runs against production — the backdoor is absent there.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const TIMEOUT = 30_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const freshEmail = () => `test_${randomUUID()}@gmail.com`;

interface Account {
  email: string;
  context: BrowserContext;
  page: Page;
}

/**
 * Open a fresh browser context and dev-login as `email` through the UI
 * (`?login=true`), waiting until `/me` resolves the signed-in view.
 */
async function signIn(
  browser: Browser,
  email: string,
  admin: boolean,
): Promise<Account> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const params = new URLSearchParams({ login: 'true', email });
  if (!admin) params.set('admin', 'false');
  await page.goto(`${BASE_URL}/?${params.toString()}`);

  // The global header renders "Sign out" for any signed-in user (off the same
  // `/me` the rest of the UI reads), so it's a role-agnostic, reliable marker
  // that the dev-login + `/me` round trip finished. The admin's "Start a League"
  // CTA loads from that same `/me`, so it's present by the time we create.
  await page
    .getByRole('button', { name: 'Sign out' })
    .waitFor({ state: 'visible', timeout: TIMEOUT });

  // The session now lives in the cookie. Clear the persisted dev-login marker so
  // a later full-page navigation (e.g. reloading the homepage before deleting a
  // league) doesn't re-fire POST /auth/dev-login on mount, which would mint a
  // fresh session + CSRF token and race it out from under an in-flight mutation
  // (the delete then 403s "Invalid CSRF token"). With the marker cleared the
  // reload simply re-reads /me off the existing cookie.
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('tickr_dev_login');
    } catch {
      // sessionStorage unavailable — nothing to clear
    }
  });
  return { email, context, page };
}

/**
 * Admin opens the create-league modal, fills in the league + their team, seeds
 * the three default manager seats with the invitees' emails, and submits.
 * Returns the new league's id (read off the dashboard URL it navigates to).
 */
async function createLeague(
  adminPage: Page,
  leagueName: string,
  invitees: string[],
): Promise<string> {
  await adminPage.getByRole('button', { name: 'Start a League' }).click();
  await adminPage
    .getByRole('dialog')
    .waitFor({ state: 'visible', timeout: TIMEOUT });

  await adminPage.getByLabel('League name').fill(leagueName);
  await adminPage.getByLabel('Your team').fill('The Dip Buyers');
  // Three default seats, aria-labelled "Manager 2 email" … "Manager 4 email".
  for (let i = 0; i < invitees.length; i++) {
    await adminPage.getByLabel(`Manager ${i + 2} email`).fill(invitees[i]!);
  }

  await adminPage
    .getByRole('button', { name: 'Start League', exact: true })
    .click();
  // On success the modal routes to the new league's dashboard.
  await adminPage.waitForURL(/\/leagues\/[0-9a-fA-F-]+$/, { timeout: TIMEOUT });
  const id = adminPage.url().split('/').pop()!;
  assert(id, 'expected a league id in the dashboard URL');
  return id;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const accounts: Account[] = [];
  try {
    const leagueName = `E2E Auto-Join ${randomUUID().slice(0, 8)}`;

    // 1) Three accounts. Regulars FIRST so their accounts exist at invite time
    //    (auto-join resolves invitees against the registered user base). A fourth
    //    invitee — `pendingEmail` — is deliberately NEVER signed in beforehand,
    //    so at invite time it has no account: the create flow pre-creates an
    //    unclaimed account for it and seats it as a real manager (step 4).
    console.log('1) creating 2 regular accounts + 1 admin via dev-login…');
    const regulars: Account[] = [];
    for (let i = 0; i < 2; i++) {
      const account = await signIn(browser, freshEmail(), false);
      regulars.push(account);
      accounts.push(account);
    }
    const admin = await signIn(browser, freshEmail(), true);
    accounts.push(admin);
    const pendingEmail = freshEmail();

    // 2) Admin creates the league, inviting the two existing regulars plus the
    //    never-signed-in pendingEmail.
    console.log(
      `2) admin creating "${leagueName}" inviting 2 regulars + 1 pending invitee…`,
    );
    const leagueId = await createLeague(admin.page, leagueName, [
      ...regulars.map((r) => r.email),
      pendingEmail,
    ]);
    console.log(`   league created: ${leagueId}`);

    // 3) Each existing regular loads their homepage and sees the league listed.
    console.log('3) verifying the league is listed on each regular homepage…');
    for (const regular of regulars) {
      await regular.page.goto(`${BASE_URL}/`);
      await regular.page
        .getByRole('link', { name: leagueName })
        .waitFor({ state: 'visible', timeout: TIMEOUT });
      console.log(`   ✓ ${regular.email} sees "${leagueName}"`);
    }

    // 4) The pending invitee signs in for the FIRST time. Their dev-login binds a
    //    fresh identity to the account pre-created at invite time (the verified-
    //    email merge), so the fully-drafted league is already waiting on their
    //    homepage — no join step, no invite link to click.
    console.log(
      `4) pending invitee ${pendingEmail} signing in for the first time…`,
    );
    const pending = await signIn(browser, pendingEmail, false);
    accounts.push(pending);
    await pending.page
      .getByRole('link', { name: leagueName })
      .waitFor({ state: 'visible', timeout: TIMEOUT });
    console.log(`   ✓ ${pendingEmail} sees "${leagueName}" waiting on sign-in`);

    // 5) Teardown: admin deletes the league from the homepage. Set KEEP_LEAGUE=1
    //    to skip this and leave the league + accounts in place for inspection.
    if (process.env.KEEP_LEAGUE) {
      console.log('5) KEEP_LEAGUE set — skipping delete, leaving the league.');
    } else {
      console.log('5) admin deleting the league…');
      await admin.page.goto(`${BASE_URL}/`);
      await admin.page
        .getByRole('button', { name: `Delete ${leagueName}` })
        .click();
      await admin.page
        .getByRole('dialog')
        .waitFor({ state: 'visible', timeout: TIMEOUT });
      await admin.page
        .getByRole('button', { name: 'Delete league', exact: true })
        .click();
      // The league link drops off the homepage once the delete settles.
      await admin.page
        .getByRole('link', { name: leagueName })
        .waitFor({ state: 'detached', timeout: TIMEOUT });
      console.log('   ✓ league deleted');
    }

    console.log(
      `\nPASS — create → invite → auto-join → claim-on-sign-in${process.env.KEEP_LEAGUE ? '' : ' → delete'} all verified.`,
    );
    console.log('\n--- Summary ---');
    console.log(`league:  ${leagueName} (${leagueId})`);
    console.log(`admin:   ${admin.email}`);
    console.log('invited (existing accounts):');
    for (const regular of regulars) console.log(`  - ${regular.email}`);
    console.log(`invited (pending, signed in after): ${pending.email}`);
  } finally {
    for (const account of accounts) await account.context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\nFAIL —', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
