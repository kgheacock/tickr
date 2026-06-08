import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import styles from './LandingPage.module.css';

export function LandingPage() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && user) {
      navigate('/market', { replace: true });
    }
  }, [isLoading, user, navigate]);

  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.title}>tickr</h1>
        <p className={styles.tagline}>
          Explore historical price data and backtest trading strategies against
          the S&P 500 universe.
        </p>
        <Link to="/login" className={styles.cta}>
          Sign in to explore
        </Link>
      </div>
    </main>
  );
}
