/**
 * League context hook (item 09 step 2). Centralizes the REST reads built in
 * items 01–08 and the live `scores` topic so every FS page renders off one
 * source. It is the app's first WebSocket consumer, so it also owns the socket
 * lifecycle: connect on mount, subscribe to the league's scores topic for the
 * active week, and tear the subscription + handler down on unmount.
 *
 * Live following: the scoring path pushes `scores.updated` (provisional in-week
 * totals, then the Friday-settled final). We derive the weekly ranking from
 * those scores so the board moves without a reload (item 09 step 7).
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LeagueMember,
  Lineup,
  RosterTransactionRequest,
  SetLineupSlot,
  WeeklyScore,
} from '@tickr/shared-types';
import { client } from '../../api/client';
import { socket } from '../../api/socket';
import { useAuth } from '../../auth/AuthProvider';
import { fantasyKeys, rankScores, type RankedManager } from './api';

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

  // Latest live push from the scores topic; null until the first push. Carries
  // the provisional flag (in-week best-effort vs Friday-settled final).
  const [live, setLive] = useState<{
    scores: WeeklyScore[];
    provisional: boolean;
  } | null>(null);
  // Reset the live overlay whenever the watched week changes.
  useEffect(() => setLive(null), [leagueId, week, season]);

  // Socket lifecycle — connect once, (re)subscribe to the active week's topic,
  // and update the overlay on each matching push. Cleanup unsubscribes and
  // detaches the handler so a week change or unmount leaves no dangling state.
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    socket.connect();
    const topic = { kind: 'scores' as const, leagueId, week };
    socket.subscribe(topic);
    const off = socket.on('scores.updated', (msg) => {
      if (msg.leagueId !== leagueId || msg.week !== week) return;
      setLive({ scores: msg.scores, provisional: msg.provisional });
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
  // (already provisional from the server) keep the board current. The weekly
  // ranking is derived from these scores — there is no stored standings.
  const weeklyScores = live?.scores ?? scores.data?.scores ?? [];
  const ranking = useMemo<RankedManager[]>(
    () => rankScores(weeklyScores),
    [weeklyScores],
  );

  const provisional = live?.provisional ?? false;

  const invalidateWeek = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: fantasyKeys.lineup(leagueId, week, season),
      }),
      queryClient.invalidateQueries({
        queryKey: fantasyKeys.scores(leagueId, week, season),
      }),
    ]);

  // A saved/auto-filled lineup is the new source of the team's total: a stock's
  // slot drives its basis (Defense scores short, flipping the sign) and only the
  // started slots count, so the running/projected score shifts. Seed the fresh
  // lineup, drop any stale live overlay (the save fires no scores push of its
  // own), and refetch the week's scores so the header reflects the new lineup.
  const onLineupSaved = (next: Lineup) => {
    queryClient.setQueryData(fantasyKeys.lineup(leagueId, week, season), next);
    setLive(null);
    void queryClient.invalidateQueries({
      queryKey: fantasyKeys.scores(leagueId, week, season),
    });
  };

  const setLineup = useMutation({
    mutationFn: (slots: SetLineupSlot[]) =>
      client.setLineup(leagueId, { week, season, slots }),
    onSuccess: onLineupSaved,
  });

  const autofill = useMutation({
    mutationFn: () => client.autofillLineup(leagueId, week, season),
    onSuccess: onLineupSaved,
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

  // Rename a team. The server returns the refreshed league view; seeding it into
  // the league query updates `members`, which feeds both the masthead wordmark
  // and the standings tape (via managerLabel) without a refetch.
  const renameTeam = useMutation({
    mutationFn: (vars: { userId: string; teamName: string }) =>
      client.renameTeam(leagueId, vars.userId, vars.teamName),
    onSuccess: (view) => {
      queryClient.setQueryData(fantasyKeys.league(leagueId), view);
    },
  });

  const myUserId = user?.id ?? null;
  const myRank = useMemo(
    () =>
      myUserId ? (ranking.find((r) => r.userId === myUserId) ?? null) : null,
    [ranking, myUserId],
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
    ranking,
    myRank,
    isLoading: league.isLoading || scores.isLoading,
    error: league.error ?? scores.error ?? null,
    refetchWeek: invalidateWeek,
    renameTeam,
    setLineup,
    autofill,
    buyPlayer,
    sellPlayer,
  };
}

export type LeagueContext = ReturnType<typeof useLeague>;
