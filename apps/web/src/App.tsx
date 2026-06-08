import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { MarketPage } from './features/market/MarketPage';
import styles from './App.module.css';

export function App() {
  return (
    <AuthProvider>
      <div className={styles.app}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/market"
            element={
              <RequireAuth>
                <MarketPage />
              </RequireAuth>
            }
          />
        </Routes>
      </div>
    </AuthProvider>
  );
}
