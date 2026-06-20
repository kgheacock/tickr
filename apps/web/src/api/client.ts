import type {
  MeResponse,
  UserExistsResponse,
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
  CreateLeagueRequest,
  PlayerListResponse,
  PlayerDetail,
  RosterTransactionRequest,
  RosterTransactionResult,
  Lineup,
  SetLineupRequest,
  LeagueScoresResponse,
  SeasonWinsResponse,
  SeasonsResponse,
  Notification,
  NotificationsResponse,
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

  /** Admin-only: whether a registered tickr user has the given email. */
  checkUserExists(email: string): Promise<UserExistsResponse> {
    return this.request<UserExistsResponse>('GET', '/users/exists', undefined, {
      email,
    });
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

  /** Create a league; the caller becomes its commissioner and first member. */
  createLeague(req: CreateLeagueRequest): Promise<LeagueView> {
    return this.request<LeagueView>('POST', '/leagues', req);
  }

  /** Admin-only: permanently delete a league and all its data (cascades). */
  deleteLeague(id: string): Promise<void> {
    return this.request<void>('DELETE', `/leagues/${id}`);
  }

  /**
   * Rename a team. A manager may rename their own team (`userId` === self); the
   * commissioner may rename any member's. Returns the refreshed league view.
   */
  renameTeam(
    id: string,
    userId: string,
    teamName: string,
  ): Promise<LeagueView> {
    return this.request<LeagueView>(
      'PATCH',
      `/leagues/${id}/members/${encodeURIComponent(userId)}`,
      { teamName },
    );
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

  /** Buy an unowned stock off the wire; pass `dropSymbol` when the roster is full. */
  buyPlayer(
    id: string,
    req: RosterTransactionRequest,
  ): Promise<RosterTransactionResult> {
    return this.request<RosterTransactionResult>(
      'POST',
      `/leagues/${id}/roster`,
      req,
    );
  }

  /** Sell (drop) a stock the caller owns back to the wire. */
  sellPlayer(id: string, symbol: string): Promise<RosterTransactionResult> {
    return this.request<RosterTransactionResult>(
      'DELETE',
      `/leagues/${id}/roster/${encodeURIComponent(symbol)}`,
    );
  }

  /** The league's full stock inventory (ownership column + filters/paging). */
  getPlayers(
    id: string,
    opts: {
      group?: string;
      q?: string;
      available?: boolean;
      limit?: number;
      offset?: number;
      sort?: 'symbol' | 'lastWk';
      dir?: 'asc' | 'desc';
    } = {},
  ): Promise<PlayerListResponse> {
    const params: Record<string, string> = {};
    if (opts.group) params['group'] = opts.group;
    if (opts.q) params['q'] = opts.q;
    if (opts.available) params['available'] = 'true';
    if (opts.limit != null) params['limit'] = String(opts.limit);
    if (opts.offset != null) params['offset'] = String(opts.offset);
    if (opts.sort) params['sort'] = opts.sort;
    if (opts.dir) params['dir'] = opts.dir;
    return this.request<PlayerListResponse>(
      'GET',
      `/leagues/${id}/players`,
      undefined,
      params,
    );
  }

  /** Detail for one stock: classification, ~1y price window, scoring history. */
  getPlayerDetail(id: string, symbol: string): Promise<PlayerDetail> {
    return this.request<PlayerDetail>(
      'GET',
      `/leagues/${id}/players/${encodeURIComponent(symbol)}`,
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

  getSeasonWins(id: string, season: number): Promise<SeasonWinsResponse> {
    return this.request<SeasonWinsResponse>(
      'GET',
      `/leagues/${id}/wins`,
      undefined,
      { season: String(season) },
    );
  }

  getSeasons(id: string): Promise<SeasonsResponse> {
    return this.request<SeasonsResponse>('GET', `/leagues/${id}/seasons`);
  }

  getNotifications(id: string): Promise<NotificationsResponse> {
    return this.request<NotificationsResponse>(
      'GET',
      `/leagues/${id}/notifications`,
    );
  }

  markNotificationRead(id: string, nid: string): Promise<Notification> {
    return this.request<Notification>(
      'POST',
      `/leagues/${id}/notifications/${nid}/read`,
    );
  }

  logout(): Promise<void> {
    return this.request<void>('POST', '/auth/logout');
  }

  /**
   * DEV-ONLY: mint a real session via the server's gated dev-login backdoor.
   * Pass an email to impersonate that account; omit it for the default user.
   * Pass `admin: false` to log in as a plain player (synthetic user only).
   */
  devLogin(email?: string | null, admin: boolean = true): Promise<void> {
    const body: { email?: string; admin?: boolean } = {};
    if (email) body.email = email;
    if (!admin) body.admin = false;
    return this.request<void>(
      'POST',
      '/auth/dev-login',
      Object.keys(body).length > 0 ? body : undefined,
    );
  }
}

export const client = new ApiClient();
