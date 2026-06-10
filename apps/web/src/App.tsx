import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { LandingPage } from './pages/LandingPage';
import styles from './App.module.css';

export function App() {
  return (
    <AuthProvider>
      <div className={styles.app}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
        </Routes>
      </div>
    </AuthProvider>
  );
}
