# Getting the OAuth sign-in screens approved

> **Audience:** Keith (project owner / Google Cloud + GitHub account holder).
> **Why this exists:** TODO/20 item 3 ships branded "Sign in with Google" and
> "Sign in with GitHub" buttons. The code is done; what's left is provider-side
> setup that only the account owner can do.
>
> **The two providers are very different:**
>
> - **Google** requires real work: configure the OAuth consent screen,
>   **publish to Production**, and (for the logo/name to show) pass a
>   lightweight **brand verification**. Most of this doc covers that.
> - **GitHub** requires **no approval process at all** for sign-in — create the
>   OAuth App, optionally upload a logo (shows immediately), done. See the
>   [GitHub section](#github-no-approval-needed) at the bottom.

## TL;DR

tickr requests only **non-sensitive** scopes (`openid email profile` — see
`apps/api/src/auth/google.ts:50`). That puts us on the **easy path**:

- ❌ **No** full OAuth verification / third-party security assessment is
  required. That heavyweight process (CASA pen-test, weeks-to-months, and a
  potentially costly third-party assessment) only applies to **sensitive or
  restricted** scopes. We use none.
- ✅ You **must** finish the consent-screen config and **publish the app to
  Production** so it's not capped to a small Testing-mode test-user list
  (~100) and doesn't show the "unverified app" interstitial to people you
  didn't add as testers. (Confirm the exact cap in the console — Google has
  changed these numbers before.)
- ✅ To show the **tickr name + logo** on the consent screen, you complete a
  lighter **brand verification** (Google reviews the logo, app name, and
  homepage/privacy-policy links). Until that clears, the app still works — it
  just shows your project/email instead of the branded logo.

Net: a few forms and a review that is typically days, not months.

---

## One-time decision: branded logo or not?

You can serve real users **without** brand verification. The trade-off:

| | Without brand verification | With brand verification |
|---|---|---|
| Consent screen shows | App name as plain text, no logo | "tickr" + logo |
| Review wait | None | ~1–5 business days (can be longer) |
| Still need to publish to Production? | Yes | Yes |

Recommendation: **publish to Production first** (unblocks real beta users
immediately), then submit brand verification so the logo lands when Google
gets to it. The two are independent.

---

## Prerequisites (gather before you start)

- A **Google Cloud project** for tickr (the one whose OAuth client ID/secret
  are in the API's env — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
- A reachable **homepage URL** (the deployed tickr site).
- A reachable **privacy policy URL** on the same domain. Google **will**
  check this for brand verification — it must load and be on the app's
  domain. If one doesn't exist yet, that's a blocker for the logo step (not
  for publishing).
- The **app logo**: a square PNG/JPG/BMP (Google's documented size is
  **120×120 px**; confirm current requirements in the upload dialog), no
  rounded corners added by you (Google masks it). `docs/tickr-logo.svg` can be
  exported to a square PNG for this.
- An authorized **domain** (e.g. `tickr.app`) verified in Google Search
  Console under the same Google account — required to list it as an
  authorized domain.

> ⚠️ **Known issue to fix first:** the production Google OAuth app reportedly
> uses the name **`ticker`**, not `tickr` (see project memory
> `project-google-oauth-typo`). Fix the app name on the consent screen
> **before** submitting for brand verification, or the verified branding will
> say "ticker".

---

## Step 1 — Configure the OAuth consent screen

1. Google Cloud Console → **APIs & Services → OAuth consent screen** (newer
   consoles: **Google Auth Platform → Branding**). Make sure the correct
   tickr project is selected in the top project picker.
2. **User type: External.** (Internal is only for Google Workspace orgs
   serving their own members.)
3. Fill **App information**:
   - **App name:** `tickr` (fix the `ticker` typo here).
   - **User support email:** your support address.
   - **App logo:** upload the 120×120 PNG (this is what triggers brand
     verification later).
4. **App domain:**
   - Application home page: your homepage URL.
   - Privacy policy link: your privacy-policy URL.
   - Terms of service: optional but nice.
5. **Authorized domains:** add the app's root domain (e.g. `tickr.app`).
6. **Developer contact information:** your email.
7. **Scopes:** confirm only `openid`, `.../auth/userinfo.email`, and
   `.../auth/userinfo.profile` are listed. **Do not** add anything from the
   sensitive/restricted lists — doing so flips us onto the heavyweight
   verification path. (Matches `scope: 'openid email profile'` in code.)
8. Save.

## Step 2 — Publish to Production

1. On the OAuth consent screen / **Audience** page, find **Publishing
   status**. It starts as **Testing** (capped to the test-user list, and
   non-testers see "Google hasn't verified this app").
2. Click **Publish app** → confirm **Push to production**.
3. Result for our non-sensitive scopes: real users outside the test list can
   now sign in. If you uploaded a logo / custom app name, Google will mark
   branding as **"Verification required"** or **"in review"** — that's
   Step 3, and sign-in keeps working meanwhile (just without the verified
   logo/name).

## Step 3 — Brand verification (logo + app name)

Only needed if you want the tickr logo/name on the consent screen.

1. After publishing, the console shows a **"Prepare for verification"** /
   **"Submit for verification"** prompt for branding. Open it.
2. Confirm the app name, logo, homepage, and privacy-policy URL are all set
   and reachable (Google re-checks these automatically — broken/privacy-
   policy-missing is the #1 rejection cause).
3. Add a short justification if asked (e.g. "Consumer web app; uses sign-in
   only for account identity via email/profile").
4. Submit. You'll get email updates. Turnaround is often **a few business
   days** but can take longer; Google may email asking you to fix the privacy
   policy or domain.
5. When approved, the branded consent screen goes live automatically.

---

## The button must stay brand-compliant

Brand review also looks at how you present "Sign in with Google." The login
button in `apps/web/src/pages/LoginPage.tsx` is already built to Google's
[Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines):

- Text is exactly **"Sign in with Google"** (an approved phrase).
- The **multicolor "G"** is unmodified — not recolored, not monochrome, not
  resized off its aspect ratio.
- **Dark-theme** treatment per spec: button fill `#131314`, 1px `#8E918F`
  border, text `#E3E3E3`, with the colored "G" placed directly on the dark
  fill — matching Google's current official dark "Sign in with Google" button.
  (Note: the guidelines' "logo on a white background" rule is about using the
  G mark *standalone*, not inside the dark button; the official dark button
  does not wrap the G in a white tile. If a reviewer ever objects, the
  zero-risk fix is to drop in Google's own downloadable button asset.)

If the button is ever restyled, keep it within the guidelines — an off-spec
button is itself grounds for brand-verification rejection. The one knowing
deviation: we use the app's system font instead of Roboto Medium. That's a
cosmetic divergence from the spec; if a reviewer flags it, load Roboto for
this button. Everything else (text, logo, colors, layout) is compliant.

---

## What you (Keith) actually need to do

- [ ] Select the correct tickr Google Cloud project.
- [ ] Fix the **`ticker` → `tickr`** app-name typo on the consent screen.
- [ ] Ensure a **privacy policy** is live on the app domain (blocker for the
      logo; not for publishing).
- [ ] Export `docs/tickr-logo.svg` to a 120×120 PNG and upload it.
- [ ] **Publish to Production** (Step 2) — unblocks beta users immediately.
- [ ] **Submit brand verification** (Step 3) for the logo/name.
- [ ] Provide the **request-access form URL** (separate TODO/20 item 2) so
      the closed-beta CTA can be wired up.

## If something is "sensitive" later

If tickr ever adds Google scopes beyond `openid email profile` (e.g. Calendar,
Drive, Gmail), it jumps to the **sensitive/restricted** track: full
verification, a security questionnaire, and possibly a paid third-party
security assessment. Avoid that unless a feature genuinely needs it — the
current sign-in identity flow does not.

---

## GitHub: no approval needed

Unlike Google, GitHub has **no verification or approval gate** for using an
OAuth App to sign users in, and **no "unverified app" warning screen**. The
button (`apps/web/src/pages/LoginPage.tsx`) points at
`/api/v1/auth/github/start`, and the app requests only `read:user user:email`
(see `apps/api/src/auth/github.ts:26`) — nothing that triggers review.

GitHub's only "verification" concept — **publisher verification** — exists
solely to offer **paid plans** or show a badge on a **GitHub Marketplace**
listing. tickr isn't listing on the Marketplace, so it does **not** apply.

### What you (Keith) need to do for GitHub

- [ ] In **GitHub → Settings → Developer settings → OAuth Apps**, confirm the
      tickr OAuth App's **Authorization callback URL** is exactly:

      ```
      <PUBLIC_BASE_URL>/api/v1/auth/github/callback
      ```

      where `<PUBLIC_BASE_URL>` is the API's `PUBLIC_BASE_URL` env var. For the
      local/dev value in `.env.example` that's
      `https://local.tickr.keithheacock.com/api/v1/auth/github/callback`; use
      the production host for the prod OAuth App. (The path is built in
      `apps/api/src/routes/auth/start.ts:16` as
      `${baseUrl}/api/v1/auth/${provider}/callback`.) GitHub requires an exact
      match — a trailing-slash or host mismatch breaks the callback.
- [ ] Confirm `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in the API env match
      that app.
- [ ] *(Optional)* Upload an app logo in the OAuth App settings — it appears
      on the "Authorize tickr" screen immediately, no review.

That's it. The authorization screen shows the app name, optional logo, and the
requested scopes with no warning interstitial. (The only per-user requirement
is GitHub's own rule that a user must have a verified email on their account
before authorizing any OAuth app — not something you approve.)

| | Google | GitHub |
|---|---|---|
| Approval gate before real users sign in? | **Yes** (publish to Production) | **No** |
| "Unverified app" warning screen? | Yes, until published/verified | **None** |
| Logo review? | Yes (brand verification) | **No** — shows immediately |
| Any verification at all? | Consent-screen brand/scope verification | Only for **Marketplace** listings (N/A here) |

## References

- Google — OAuth app verification (which apps need it):
  https://support.google.com/cloud/answer/13463073
- Google — Sign in with Google branding guidelines:
  https://developers.google.com/identity/branding-guidelines
- Google — Setting up the OAuth consent screen:
  https://support.google.com/cloud/answer/10311615
- GitHub — Creating an OAuth App:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
- GitHub — Authorizing OAuth apps:
  https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps
- GitHub — Publisher verification (Marketplace only):
  https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization
