import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createChart, ColorType } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { client } from '../../api/client';
import { socket } from '../../api/socket';
import { formatCents } from '../../lib/format';
import styles from './MarketPage.module.css';

function useSocketConnected(): boolean {
  const [connected, setConnected] = useState(() => socket.connected);
  useEffect(() => {
    const id = setInterval(() => setConnected(socket.connected), 5_000);
    return () => clearInterval(id);
  }, []);
  return connected;
}

function toChartTime(isoTs: string): UTCTimestamp {
  return (new Date(isoTs).getTime() / 1_000) as UTCTimestamp;
}

export function MarketPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const socketConnected = useSocketConnected();

  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [filter, setFilter] = useState('');

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const { data: universe } = useQuery({
    queryKey: ['universe', 'backfilled'],
    queryFn: () => client.getUniverse(true),
  });

  const { data: prices } = useQuery({
    queryKey: ['prices', selectedSymbol],
    queryFn: () => client.getPrices([selectedSymbol]),
    enabled: !!selectedSymbol,
    refetchInterval:
      !socketConnected && socket.disconnectedForMs > 30_000 ? 30_000 : false,
  });

  const handleLogout = useCallback(async () => {
    await client.logout();
    // Clear the cached session so `user` flips to null immediately. Invalidating
    // would refetch /me, but a failed (401) refetch retains the last successful
    // data, leaving LandingPage to bounce us back to /market.
    queryClient.setQueryData(['me'], null);
    navigate('/', { replace: true });
  }, [queryClient, navigate]);

  // Default to first symbol when universe loads
  useEffect(() => {
    if (!selectedSymbol && universe?.items[0]) {
      setSelectedSymbol(universe.items[0].symbol);
    }
  }, [universe, selectedSymbol]);

  // Initialize chart
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#1a1d27' },
        textColor: '#e2e8f0',
      },
      grid: {
        vertLines: { color: '#2a2d3a' },
        horzLines: { color: '#2a2d3a' },
      },
      width: container.clientWidth,
      height: 400,
      timeScale: { timeVisible: true },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addLineSeries({
      color: '#4f8ef7',
      lineWidth: 2,
    });

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Feed historical price data to chart when symbol or data changes
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !prices || !selectedSymbol) return;
    const bars = prices.series[selectedSymbol];
    if (!bars) return;
    series.setData(
      bars.map((bar) => ({
        time: toChartTime(bar.ts),
        value: bar.close / 100,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [prices, selectedSymbol]);

  // WS subscription for live price updates on the selected symbol
  useEffect(() => {
    if (!selectedSymbol) return;
    const topic = { kind: 'prices' as const, symbols: [selectedSymbol] };
    socket.subscribe(topic);

    const unsub = socket.on('prices.updated', (msg) => {
      const bars = msg.series[selectedSymbol];
      const bar = bars?.at(-1);
      if (!bar || !seriesRef.current) return;
      seriesRef.current.update({
        time: toChartTime(bar.ts),
        value: bar.close / 100,
      });
    });

    return () => {
      socket.unsubscribe(topic);
      unsub();
    };
  }, [selectedSymbol]);

  // Connect WS on mount; disconnect on unmount
  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, []);

  const filteredSymbols =
    universe?.items.filter((item) =>
      item.symbol.includes(filter.toUpperCase()),
    ) ?? [];

  const currentBar =
    selectedSymbol && prices
      ? prices.series[selectedSymbol]?.at(-1)
      : undefined;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>tickr</span>
        <Link className={styles.navLink} to="/strategy">
          Strategy
        </Link>
        <div className={styles.headerRight}>
          <span className={styles.username}>{user?.displayName}</span>
          <button className={styles.logoutBtn} onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h2 className={styles.sidebarTitle}>Universe</h2>
            <span className={styles.symbolCount}>
              {universe?.items.length ?? '—'} symbols
            </span>
          </div>
          <input
            className={styles.filterInput}
            type="text"
            placeholder="Filter symbols…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className={styles.symbolList}>
            {filteredSymbols.map((item) => (
              <button
                key={item.symbol}
                className={`${styles.symbolRow} ${item.symbol === selectedSymbol ? styles.selected : ''}`}
                onClick={() => setSelectedSymbol(item.symbol)}
              >
                {item.symbol}
              </button>
            ))}
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.symbolHeader}>
            <h2 className={styles.symbolTitle}>{selectedSymbol || '—'}</h2>
            {currentBar && (
              <span className={styles.lastPrice}>
                {formatCents(currentBar.close)}
              </span>
            )}
            {!socketConnected && (
              <span className={styles.wsOffline}>● live feed offline</span>
            )}
          </div>
          <div ref={chartContainerRef} className={styles.chart} />
          {prices?.from && prices.to && (
            <p className={styles.chartFooter}>
              {new Date(prices.from).toLocaleDateString()} –{' '}
              {new Date(prices.to).toLocaleDateString()}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
