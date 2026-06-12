import type {
  MeResponse,
  UniverseResponse,
  PricesResponse,
  EvaluateRequest,
  EvaluateResponse,
  Etf,
  EtfListResponse,
  CreateEtfRequest,
  SmaStrategyRequest,
  StrategyBacktestResponse,
  ApiError,
  LeagueListResponse,
  LeagueView,
  PlayerListResponse,
  Lineup,
  SetLineupRequest,
  LeagueScoresResponse,
  MatchupsResponse,
  ScheduleResponse,
  StandingsResponse,
  SeasonsResponse,
} from '@tickr/shared-types';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

class ApiClient {
  private csrfToken: string | null = null;

  setCsrfToken(token: string): void {
    this.csrfToken = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, window.location.origin);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.csrfToken && method !== 'GET') {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    const res = await fetch(url.toString(), {
      method,
      credentials: 'include',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let code = 'INTERNAL';
      let message = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as ApiError;
        code = err.error.code;
        message = err.error.message;
      } catch {
        // response wasn't JSON
      }
      throw new ApiClientError(res.status, code, message);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  getMe(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/me');
  }

  getUniverse(backfilledOnly = false): Promise<UniverseResponse> {
    return this.request<UniverseResponse>('GET', '/universe', undefined, {
      backfilled: String(backfilledOnly),
    });
  }

  getPrices(
    symbols: string[],
    from?: string,
    to?: string,
  ): Promise<PricesResponse> {
    const params: Record<string, string> = { symbols: symbols.join(',') };
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.request<PricesResponse>('GET', '/prices', undefined, params);
  }

  evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
    return this.request<EvaluateResponse>('POST', '/evaluate', req);
  }

  listEtfs(): Promise<EtfListResponse> {
    return this.request<EtfListResponse>('GET', '/etfs');
  }

  getEtf(key: string): Promise<Etf> {
    return this.request<Etf>('GET', `/etfs/${encodeURIComponent(key)}`);
  }

  createEtf(req: CreateEtfRequest): Promise<Etf> {
    return this.request<Etf>('POST', '/etfs', req);
  }

  runSmaStrategy(req: SmaStrategyRequest): Promise<StrategyBacktestResponse> {
    return this.request<StrategyBacktestResponse>(
      'POST',
      '/strategies/sma-crossover',
      req,
    );
  }

  // --- Fantasy Street (item 09 dashboard reads the 01–08 endpoints) ---

  /** Leagues the caller belongs to (`mine`) or can join (`open`). */
  listLeagues(filter: 'mine' | 'open' = 'mine'): Promise<LeagueListResponse> {
    return this.request<LeagueListResponse>('GET', '/leagues', undefined, {
      [filter]: 'true',
    });
  }

  getLeague(id: string): Promise<LeagueView> {
    return this.request<LeagueView>('GET', `/leagues/${id}`);
  }

  /** The caller's roster (owned players) for a league — the lineup pick pool. */
  getRoster(id: string): Promise<PlayerListResponse> {
    return this.request<PlayerListResponse>(
      'GET',
      `/leagues/${id}/players`,
      undefined,
      { mine: 'true', limit: '200' },
    );
  }

  getLineup(id: string, week: number, season: number): Promise<Lineup> {
    return this.request<Lineup>('GET', `/leagues/${id}/lineup`, undefined, {
      week: String(week),
      season: String(season),
    });
  }

  setLineup(id: string, req: SetLineupRequest): Promise<Lineup> {
    return this.request<Lineup>('PUT', `/leagues/${id}/lineup`, req);
  }

  autofillLineup(id: string, week: number, season: number): Promise<Lineup> {
    return this.request<Lineup>('POST', `/leagues/${id}/lineup/autofill`, {
      week,
      season,
    });
  }

  getScores(
    id: string,
    week: number,
    season: number,
  ): Promise<LeagueScoresResponse> {
    return this.request<LeagueScoresResponse>(
      'GET',
      `/leagues/${id}/scores`,
      undefined,
      { week: String(week), season: String(season) },
    );
  }

  getMatchups(
    id: string,
    week: number,
    season: number,
  ): Promise<MatchupsResponse> {
    return this.request<MatchupsResponse>(
      'GET',
      `/leagues/${id}/matchups`,
      undefined,
      { week: String(week), season: String(season) },
    );
  }

  getSchedule(id: string, season: number): Promise<ScheduleResponse> {
    return this.request<ScheduleResponse>(
      'GET',
      `/leagues/${id}/schedule`,
      undefined,
      { season: String(season) },
    );
  }

  getStandings(id: string, season: number): Promise<StandingsResponse> {
    return this.request<StandingsResponse>(
      'GET',
      `/leagues/${id}/standings`,
      undefined,
      { season: String(season) },
    );
  }

  getSeasons(id: string): Promise<SeasonsResponse> {
    return this.request<SeasonsResponse>('GET', `/leagues/${id}/seasons`);
  }

  logout(): Promise<void> {
    return this.request<void>('POST', '/auth/logout');
  }

  /** DEV-ONLY: mint a real session via the server's gated dev-login backdoor. */
  devLogin(): Promise<void> {
    return this.request<void>('POST', '/auth/dev-login');
  }
}

export const client = new ApiClient();
