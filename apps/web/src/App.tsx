import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { Header } from './components/Header';
import { LandingPage } from './pages/LandingPage';
import { LeaguesPage } from './features/fantasy/LeaguesPage';
import { FantasyLayout } from './features/fantasy/FantasyLayout';
import { Dashboard } from './features/fantasy/Dashboard';
import { TeamView } from './features/fantasy/TeamView';
import { InventoryView } from './features/fantasy/InventoryView';
import styles from './App.module.css';

export function App() {
  return (
    <AuthProvider>
      <div className={styles.app}>
        <Header />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route
            path="/leagues"
            element={
              <RequireAuth>
                <LeaguesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/leagues/:id"
            element={
              <RequireAuth>
                <FantasyLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="team" element={<TeamView />} />
            <Route path="players" element={<InventoryView />} />
          </Route>
        </Routes>
      </div>
    </AuthProvider>
  );
}
