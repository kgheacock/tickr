import type {
  WsClientMessage,
  WsTopic,
  WsServerMessage,
} from '@tickr/shared-types';

type MessageHandler = (msg: WsServerMessage) => void;

function topicKey(topic: WsTopic): string {
  switch (topic.kind) {
    case 'universe':
      return 'universe';
    case 'draft':
      return `draft:${topic.leagueId}`;
    case 'matchup':
      return `matchup:${topic.leagueId}:${topic.week}`;
    case 'prices':
      return `prices:${[...topic.symbols].sort().join(',')}`;
    case 'notifications':
      return 'notifications';
  }
}

class TickrSocket {
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private readonly maxBackoffMs = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedAt: number | null = null;
  readonly activeTopics = new Map<string, WsTopic>();
  private readonly eventHandlers = new Map<string, Set<MessageHandler>>();

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Milliseconds since last disconnect, or 0 if currently connected. */
  get disconnectedForMs(): number {
    return this.disconnectedAt !== null ? Date.now() - this.disconnectedAt : 0;
  }

  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.open();
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  subscribe(topic: WsTopic): void {
    const key = topicKey(topic);
    this.activeTopics.set(key, topic);
    if (this.connected) {
      this.send({ type: 'subscribe', topic });
    }
  }

  unsubscribe(topic: WsTopic): void {
    const key = topicKey(topic);
    this.activeTopics.delete(key);
    if (this.connected) {
      this.send({ type: 'unsubscribe', topic });
    }
  }

  on<T extends WsServerMessage['type']>(
    type: T,
    handler: (msg: Extract<WsServerMessage, { type: T }>) => void,
  ): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set<MessageHandler>();
      this.eventHandlers.set(type, set);
    }
    const fn = handler as MessageHandler;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  private open(): void {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.backoffMs = 1_000;
      this.disconnectedAt = null;
      this.resubscribeAll();
    };

    this.ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        this.dispatch(msg);
      } catch {
        // malformed message — ignore
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.disconnectedAt === null) {
        this.disconnectedAt = Date.now();
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private resubscribeAll(): void {
    for (const topic of this.activeTopics.values()) {
      this.send({ type: 'subscribe', topic });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private dispatch(msg: WsServerMessage): void {
    const handlers = this.eventHandlers.get(msg.type);
    if (!handlers) return;
    for (const h of handlers) {
      h(msg);
    }
  }
}

export const socket = new TickrSocket();
