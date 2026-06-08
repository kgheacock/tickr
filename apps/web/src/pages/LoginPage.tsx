import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && user) {
      navigate('/market', { replace: true });
    }
  }, [isLoading, user, navigate]);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Sign in to tickr</h1>
        <p className={styles.sub}>Use your Google or GitHub account.</p>
        <div className={styles.providers}>
          <a href="/api/v1/auth/google/start" className={styles.btn}>
            Sign in with Google
          </a>
          <a href="/api/v1/auth/github/start" className={styles.btn}>
            Sign in with GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
