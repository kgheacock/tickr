/**
 * Global app header — a thin newspaper "folio" strip across the top of every
 * page. Shows the tickr wordmark (home link) and the signed-in account: an
 * `ACCOUNT: <email>` line plus Sign out. Account email + Sign out were moved
 * here out of the LandingPage aside, so this is the single account surface.
 *
 * Renders nothing when logged out or while auth is resolving — logged-out users
 * only ever see the landing page, which carries its own masthead, so a utility
 * bar there would just duplicate the brand.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useLogout } from '../auth/useLogout';
import styles from './Header.module.css';

export function Header() {
  const { user, isLoading } = useAuth();
  const handleLogout = useLogout();

  if (isLoading || !user) return null;

  return (
    <header className={styles.bar}>
      <Link to="/" className={styles.brand}>
        tickr
      </Link>
      <div className={styles.account}>
        <span className={styles.label}>Account:</span>
        <span className={styles.email}>{user.email}</span>
        <button type="button" className={styles.signout} onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
