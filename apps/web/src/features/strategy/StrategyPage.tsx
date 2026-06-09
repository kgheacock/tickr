import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useLogout } from '../../auth/useLogout';
import { client, ApiClientError } from '../../api/client';
import { LineChart } from '../../components/LineChart';
import { formatCents } from '../../lib/format';
import styles from './StrategyPage.module.css';

interface Member {
  symbol: string;
  weight: string; // kept as string for free editing; parsed on save
}

const DEFAULT_SHORT = 20;
const DEFAULT_LONG = 50;
const DEFAULT_CASH_DOLLARS = 10_000;

function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function StrategyPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [activeKey, setActiveKey] = useState('sp500');
  const [members, setMembers] = useState<Member[]>([]);
  const [addSymbol, setAddSymbol] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');

  const [shortWindow, setShortWindow] = useState(DEFAULT_SHORT);
  const [longWindow, setLongWindow] = useState(DEFAULT_LONG);
  const [cashDollars, setCashDollars] = useState(DEFAULT_CASH_DOLLARS);

  const { data: seed } = useQuery({
    queryKey: ['etf', 'sp500'],
    queryFn: () => client.getEtf('sp500'),
  });

  const { data: universe } = useQuery({
    queryKey: ['universe', 'backfilled'],
    queryFn: () => client.getUniverse(true),
  });

  // Seed the editable basket from sp500 once it loads.
  useEffect(() => {
    if (seed && members.length === 0) {
      setMembers(
        seed.weights.map((w) => ({
          symbol: w.symbol,
          weight: w.weight.toFixed(4),
        })),
      );
    }
  }, [seed, members.length]);

  const memberSymbols = useMemo(
    () => new Set(members.map((m) => m.symbol)),
    [members],
  );
  const addableSymbols = useMemo(
    () =>
      universe?.items
        .map((i) => i.symbol)
        .filter((s) => !memberSymbols.has(s)) ?? [],
    [universe, memberSymbols],
  );

  const saveMutation = useMutation({
    mutationFn: () => {
      const weights: Record<string, number> = {};
      for (const m of members) {
        const w = parseFloat(m.weight);
        if (Number.isFinite(w) && w > 0) weights[m.symbol] = w;
      }
      return client.createEtf({ key: newKey, name: newName, weights });
    },
    onSuccess: (etf) => {
      setActiveKey(etf.key);
      void queryClient.invalidateQueries({ queryKey: ['etfs'] });
    },
  });

  const backtest = useMutation({
    mutationFn: () =>
      client.runSmaStrategy({
        etfKey: activeKey,
        shortWindow,
        longWindow,
        startingCash: Math.round(cashDollars * 100),
      }),
  });

  const handleLogout = useLogout();

  const updateWeight = (symbol: string, weight: string) =>
    setMembers((ms) =>
      ms.map((m) => (m.symbol === symbol ? { ...m, weight } : m)),
    );
  const removeMember = (symbol: string) =>
    setMembers((ms) => ms.filter((m) => m.symbol !== symbol));
  const addMember = () => {
    if (!addSymbol || memberSymbols.has(addSymbol)) return;
    setMembers((ms) => [...ms, { symbol: addSymbol, weight: '1.0000' }]);
    setAddSymbol('');
  };

  const result = backtest.data;
  const chartSeries = result
    ? [
        {
          label: 'SMA strategy',
          color: '#4f8ef7',
          points: result.strategy.equityCurve,
        },
        {
          label: 'Buy & hold',
          color: '#7a8599',
          points: result.buyHold.equityCurve,
        },
      ]
    : [];

  const canSave =
    newKey.trim() !== '' && newName.trim() !== '' && members.length > 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>tickr</span>
        <nav className={styles.nav}>
          <Link to="/market">Market</Link>
          <span className={styles.navActive}>Strategy</span>
        </nav>
        <div className={styles.headerRight}>
          <span className={styles.username}>{user?.displayName}</span>
          <button className={styles.logoutBtn} onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.editor}>
          <h2 className={styles.sectionTitle}>ETF basket</h2>
          <p className={styles.hint}>
            Forked from <strong>{seed?.name ?? 'S&P 500'}</strong>. Edit members
            and weights, then save as your own ETF to backtest it. Weights
            normalize on save.
          </p>

          <div className={styles.memberList}>
            {members.map((m) => (
              <div key={m.symbol} className={styles.memberRow}>
                <span className={styles.memberSymbol}>{m.symbol}</span>
                <input
                  className={styles.weightInput}
                  type="number"
                  min="0"
                  step="0.0001"
                  value={m.weight}
                  onChange={(e) => updateWeight(m.symbol, e.target.value)}
                />
                <button
                  className={styles.removeBtn}
                  onClick={() => removeMember(m.symbol)}
                  aria-label={`Remove ${m.symbol}`}
                >
                  ×
                </button>
              </div>
            ))}
            {members.length === 0 && (
              <p className={styles.hint}>Loading basket…</p>
            )}
          </div>

          <div className={styles.addRow}>
            <select
              className={styles.select}
              value={addSymbol}
              onChange={(e) => setAddSymbol(e.target.value)}
            >
              <option value="">Add symbol…</option>
              {addableSymbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              className={styles.btn}
              onClick={addMember}
              disabled={!addSymbol}
            >
              Add
            </button>
          </div>

          <h2 className={styles.sectionTitle}>Save as your ETF</h2>
          <input
            className={styles.textInput}
            placeholder="key (e.g. my-etf)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            className={styles.textInput}
            placeholder="name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className={styles.btnPrimary}
            onClick={() => saveMutation.mutate()}
            disabled={!canSave || saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save ETF'}
          </button>
          {saveMutation.error && (
            <p className={styles.error}>
              {saveMutation.error instanceof ApiClientError
                ? saveMutation.error.message
                : 'Save failed'}
            </p>
          )}
          {saveMutation.isSuccess && (
            <p className={styles.ok}>Saved as “{activeKey}”.</p>
          )}
        </aside>

        <main className={styles.main}>
          <h2 className={styles.sectionTitle}>SMA-crossover backtest</h2>
          <div className={styles.controls}>
            <label className={styles.control}>
              ETF
              <span className={styles.controlValue}>{activeKey}</span>
            </label>
            <label className={styles.control}>
              Short SMA
              <input
                type="number"
                min="1"
                value={shortWindow}
                onChange={(e) => setShortWindow(Number(e.target.value))}
              />
            </label>
            <label className={styles.control}>
              Long SMA
              <input
                type="number"
                min="2"
                value={longWindow}
                onChange={(e) => setLongWindow(Number(e.target.value))}
              />
            </label>
            <label className={styles.control}>
              Starting cash ($)
              <input
                type="number"
                min="0"
                step="100"
                value={cashDollars}
                onChange={(e) => setCashDollars(Number(e.target.value))}
              />
            </label>
            <button
              className={styles.btnPrimary}
              onClick={() => backtest.mutate()}
              disabled={backtest.isPending}
            >
              {backtest.isPending ? 'Running…' : 'Run backtest'}
            </button>
          </div>

          {backtest.error && (
            <p className={styles.error}>
              {backtest.error instanceof ApiClientError
                ? backtest.error.message
                : 'Backtest failed'}
            </p>
          )}

          {result && (
            <>
              <div className={styles.stats}>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>Strategy return</span>
                  <span
                    className={
                      (result.strategy.totalReturnPct ?? 0) >= 0
                        ? styles.statPos
                        : styles.statNeg
                    }
                  >
                    {formatPct(result.strategy.totalReturnPct)}
                  </span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>
                    Buy &amp; hold return
                  </span>
                  <span
                    className={
                      (result.buyHold.totalReturnPct ?? 0) >= 0
                        ? styles.statPos
                        : styles.statNeg
                    }
                  >
                    {formatPct(result.buyHold.totalReturnPct)}
                  </span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>
                    Strategy max drawdown
                  </span>
                  <span className={styles.statNeg}>
                    {formatPct(
                      result.strategy.maxDrawdownPct === null
                        ? null
                        : -result.strategy.maxDrawdownPct,
                    )}
                  </span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>Trades</span>
                  <span className={styles.statValue}>
                    {result.orders.filter((o) => o.status === 'filled').length}
                  </span>
                </div>
              </div>

              <LineChart series={chartSeries} />

              <p className={styles.caption}>
                {activeKey} · short {result.shortWindow} / long{' '}
                {result.longWindow} · start {formatCents(result.startingCash)} ·{' '}
                {new Date(result.from).toLocaleDateString()} –{' '}
                {new Date(result.to).toLocaleDateString()}
              </p>
            </>
          )}

          {!result && !backtest.isPending && (
            <p className={styles.hint}>
              Run a backtest to see the strategy equity curve against a
              buy-and-hold baseline.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
