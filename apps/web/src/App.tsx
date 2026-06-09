import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { LandingPage } from './pages/LandingPage';
import { MarketPage } from './features/market/MarketPage';
import { StrategyPage } from './features/strategy/StrategyPage';
import styles from './App.module.css';

export function App() {
  return (
    <AuthProvider>
      <div className={styles.app}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route
            path="/market"
            element={
              <RequireAuth>
                <MarketPage />
              </RequireAuth>
            }
          />
          <Route
            path="/strategy"
            element={
              <RequireAuth>
                <StrategyPage />
              </RequireAuth>
            }
          />
        </Routes>
      </div>
    </AuthProvider>
  );
}
