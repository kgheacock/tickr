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

  logout(): Promise<void> {
    return this.request<void>('POST', '/auth/logout');
  }

  /** DEV-ONLY: mint a real session via the server's gated dev-login backdoor. */
  devLogin(): Promise<void> {
    return this.request<void>('POST', '/auth/dev-login');
  }
}

export const client = new ApiClient();
