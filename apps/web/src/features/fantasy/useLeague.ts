/**
 * League context hook (item 09 step 2). Centralizes the REST reads built in
 * items 01–08 and the live `matchup` topic so every FS page renders off one
 * source. It is the app's first WebSocket consumer, so it also owns the socket
 * lifecycle: connect on mount, subscribe to the league's matchup topic for the
 * active week, and tear the subscription + handler down on unmount.
 *
 * Live following: the scoring path pushes `matchup.updated` (provisional in-week
 * totals, then the Friday-settled final). We overlay those onto the REST
 * matchups so the scoreboard moves without a reload (item 09 step 7). The TODO's
 * speculative `score.updated`/`lineup.locked`/`waiver.processed` messages don't
 * exist server-side (see shared-types/ws.ts) — `matchup.updated` is the wire.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LeagueMember,
  Matchup,
  RosterTransactionRequest,
  SetLineupSlot,
  WeeklyScore,
} from '@tickr/shared-types';
import { client } from '../../api/client';
import { socket } from '../../api/socket';
import { useAuth } from '../../auth/AuthProvider';
import { applyLiveScores, fantasyKeys } from './api';

export interface UseLeagueOptions {
  week: number;
  season: number;
}

export function useLeague(leagueId: string, opts: UseLeagueOptions) {
  const { week, season } = opts;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const league = useQuery({
    queryKey: fantasyKeys.league(leagueId),
    queryFn: () => client.getLeague(leagueId),
  });
  const lineup = useQuery({
    queryKey: fantasyKeys.lineup(leagueId, week, season),
    queryFn: () => client.getLineup(leagueId, week, season),
  });
  const scores = useQuery({
    queryKey: fantasyKeys.scores(leagueId, week, season),
    queryFn: () => client.getScores(leagueId, week, season),
  });
  const matchups = useQuery({
    queryKey: fantasyKeys.matchups(leagueId, week, season),
    queryFn: () => client.getMatchups(leagueId, week, season),
  });
  const standings = useQuery({
    queryKey: fantasyKeys.standings(leagueId, season),
    queryFn: () => client.getStandings(leagueId, season),
  });

  // Latest live totals from the matchup topic; null until the first push.
  const [liveScores, setLiveScores] = useState<WeeklyScore[] | null>(null);
  // Reset the live overlay whenever the watched week changes.
  useEffect(() => setLiveScores(null), [leagueId, week, season]);

  // Socket lifecycle — connect once, (re)subscribe to the active week's topic,
  // and update the overlay on each matching push. Cleanup unsubscribes and
  // detaches the handler so a week change or unmount leaves no dangling state.
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    socket.connect();
    const topic = { kind: 'matchup' as const, leagueId, week };
    socket.subscribe(topic);
    const off = socket.on('matchup.updated', (msg) => {
      if (msg.leagueId !== leagueId || msg.week !== week) return;
      setLiveScores(msg.scores);
    });
    const poll = setInterval(() => setConnected(socket.connected), 1_000);
    setConnected(socket.connected);
    return () => {
      off();
      socket.unsubscribe(topic);
      clearInterval(poll);
    };
  }, [leagueId, week]);

  const members = useMemo(() => {
    const map = new Map<string, LeagueMember>();
    for (const m of league.data?.members ?? []) map.set(m.userId, m);
    return map;
  }, [league.data]);

  // Live overlay precedence: a WS push wins; otherwise the REST week's scores
  // (already provisional from the server) keep the board current. Used for both
  // the scoreboard points and the per-slot breakdowns in the matchup view.
  const weeklyScores = liveScores ?? scores.data?.scores ?? [];
  const liveMatchups = useMemo<Matchup[]>(() => {
    const base = matchups.data?.matchups ?? [];
    return weeklyScores.length > 0 ? applyLiveScores(base, weeklyScores) : base;
  }, [matchups.data, weeklyScores]);

  const provisional =
    liveScores != null || (matchups.data?.provisional ?? false);

  const invalidateWeek = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: fantasyKeys.lineup(leagueId, week, season),
      }),
      queryClient.invalidateQueries({
        queryKey: fantasyKeys.scores(leagueId, week, season),
      }),
    ]);

  const setLineup = useMutation({
    mutationFn: (slots: SetLineupSlot[]) =>
      client.setLineup(leagueId, { week, season, slots }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        fantasyKeys.lineup(leagueId, week, season),
        next,
      );
    },
  });

  const autofill = useMutation({
    mutationFn: () => client.autofillLineup(leagueId, week, season),
    onSuccess: (next) => {
      queryClient.setQueryData(
        fantasyKeys.lineup(leagueId, week, season),
        next,
      );
    },
  });

  // Buy/sell change ownership, so the roster (lineup pool), the wire inventory,
  // and the saved lineup can all shift — refetch each after a transaction.
  const invalidateRoster = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['fantasy', 'roster', leagueId],
      }),
      queryClient.invalidateQueries({
        queryKey: ['fantasy', 'inventory', leagueId],
      }),
      queryClient.invalidateQueries({
        queryKey: fantasyKeys.lineup(leagueId, week, season),
      }),
    ]);

  const buyPlayer = useMutation({
    mutationFn: (req: RosterTransactionRequest) =>
      client.buyPlayer(leagueId, req),
    onSuccess: invalidateRoster,
  });

  const sellPlayer = useMutation({
    mutationFn: (symbol: string) => client.sellPlayer(leagueId, symbol),
    onSuccess: invalidateRoster,
  });

  const myUserId = user?.id ?? null;
  const myMatchup = useMemo(
    () =>
      myUserId
        ? (liveMatchups.find(
            (m) => m.homeUserId === myUserId || m.awayUserId === myUserId,
          ) ?? null)
        : null,
    [liveMatchups, myUserId],
  );
  const myStanding = useMemo(
    () =>
      myUserId
        ? (standings.data?.standings.find((s) => s.userId === myUserId) ?? null)
        : null,
    [standings.data, myUserId],
  );

  return {
    leagueId,
    week,
    season,
    myUserId,
    connected,
    provisional,
    league: league.data ?? null,
    members,
    lineup: lineup.data ?? null,
    scores: weeklyScores,
    matchups: liveMatchups,
    standings: standings.data?.standings ?? [],
    myMatchup,
    myStanding,
    isLoading: league.isLoading || matchups.isLoading || standings.isLoading,
    error: league.error ?? matchups.error ?? standings.error ?? null,
    refetchWeek: invalidateWeek,
    setLineup,
    autofill,
    buyPlayer,
    sellPlayer,
  };
}

export type LeagueContext = ReturnType<typeof useLeague>;
