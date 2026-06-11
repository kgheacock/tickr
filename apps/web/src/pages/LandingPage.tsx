import { useAuth } from '../auth/AuthProvider';
import { useLogout } from '../auth/useLogout';
import { FlapBoard } from '../components/FlapBoard';
import styles from './LandingPage.module.css';

// A spread of recognizable S&P 500 names for the masthead ticker band. Symbols
// without a stored logo fall back to their ticker glyph inside FlapBoard.
const MARKET_TICKERS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'TSLA',
  'JPM',
  'V',
  'JNJ',
  'WMT',
  'KO',
  'DIS',
  'NFLX',
  'NKE',
];

// Google-account-gated request-access form (Google Forms with sign-in gate).
// The sign-in gate is the bot mitigation; the captured Google email is the
// identity that later gets granted OAuth access. See TODO/20-ui-critiques.md.
const REQUEST_ACCESS_URL = 'https://forms.gle/xhPHtFmtSvHByEqa6';

const EDITION_DATE = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

export function LandingPage() {
  const { user, isLoading } = useAuth();
  const handleLogout = useLogout();

  return (
    <div className={styles.page}>
      <div className={styles.paper}>
        <header className={styles.masthead}>
          <span className={styles.flag}>Closed Beta</span>
          <h1 className={styles.wordmark}>tickr</h1>
          <span className={styles.flag}>{EDITION_DATE}</span>
        </header>

        <div className={styles.ruleHeavy} />
        <p className={styles.subhead}>
          Head-to-Head Stock Leagues · Draft the S&amp;P 500 · Est. MMXXVI
        </p>
        <div className={styles.ruleThin} />

        <FlapBoard tickers={MARKET_TICKERS} />

        <main className={styles.hero}>
          <article className={styles.lede}>
            <p className={styles.kicker}>Fantasy Street</p>
            <h2 className={styles.headline}>
              Draft your team. Set your lineup. Earn your glory.
            </h2>
            <p className={styles.deck}>
              Fantasy football where the players are stocks. Draft the S&amp;P
              500 with your league — one owner per ticker — field a weekly
              lineup, and go head-to-head into the playoffs.
            </p>
          </article>

          <aside className={styles.column}>
            {isLoading ? null : user ? (
              <>
                <p className={styles.columnHead}>Account</p>
                <p className={styles.account}>{user.email}</p>
                <button className={styles.signout} onClick={handleLogout}>
                  Sign out
                </button>
              </>
            ) : (
              <>
                <p className={styles.columnHead}>Sign In</p>
                <div className={styles.providers}>
                  <a
                    href="/api/v1/auth/google/start"
                    className={`${styles.btn} ${styles.google}`}
                  >
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </a>
                  <a
                    href="/api/v1/auth/github/start"
                    className={`${styles.btn} ${styles.github}`}
                  >
                    <GitHubIcon />
                    <span>Continue with GitHub</span>
                  </a>
                </div>
                <div className={styles.columnRule} />
                <p className={styles.beta}>
                  tickr is presently in closed beta.{' '}
                  <a
                    href={REQUEST_ACCESS_URL}
                    className={styles.requestAccess}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Request access →
                  </a>
                </p>
              </>
            )}
          </aside>
        </main>
      </div>
    </div>
  );
}

// Inline SVGs keep the auth actions dependency-free, consistent with the
// project's dependency-light charting choice.

// Standard multicolor Google "G". Per Google's Sign in with Google branding
// guidelines the logo must not be recolored or resized away from its aspect
// ratio. See docs/oauth-provider-approval.md.
function GoogleIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.20455c0-.63864-.05727-1.25182-.16364-1.84091H9v3.48136h4.8436c-.20864 1.125-.84273 2.07818-1.79591 2.71682v2.25818h2.90818c1.70182-1.56682 2.68363-3.87409 2.68363-6.61545z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.46727-.80591 5.95636-2.18045l-2.90818-2.25818c-.80591.54-1.83682.85909-3.04818.85909-2.34409 0-4.32818-1.58318-5.03591-3.71045H.957273v2.33181C2.43818 15.9831 5.48182 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.96409 10.71c-.18-.54-.28227-1.11682-.28227-1.71s.10227-1.17.28227-1.71V4.95818H.957273C.347727 6.17318 0 7.54773 0 9c0 1.45227.347727 2.82682.957273 4.04182L3.96409 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.57955c1.32136 0 2.50773.45409 3.44045 1.34591l2.58137-2.58136C13.4632.891818 11.426 0 9 0 5.48182 0 2.43818 2.01682.957273 4.95818L3.96409 7.29C4.67182 5.16273 6.65591 3.57955 9 3.57955z"
      />
    </svg>
  );
}

// GitHub Octocat mark, monochrome (uses currentColor → white on dark button).
function GitHubIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.014 8.014 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
