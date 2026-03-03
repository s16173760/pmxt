import WebSocket from 'ws';
import { Trade } from '../types';
import { ActivityBuilder, AddressSubscriber, AddressWatcherConfig, WatchedEventActivity } from './watcher';


// ----------------------------------------------------------------------------
// GoldSky Config
// ----------------------------------------------------------------------------

/**
 * Builds the GraphQL subscription document for a given address.
 */
export type GoldSkySubscriptionBuilder = (
    address: string,
) => { query: string; variables?: Record<string, any> };

export interface GoldSkyConfig {
    /**
     * GoldSky GraphQL WebSocket endpoint (graphql-transport-ws protocol).
     *
     * In the Goldsky managed community project there exists the uniswap-v3-base/1.0.0
     * subgraph with a tag of prod
     * @default: https://https://api.goldsky.com/api/public/project_cl8ylkiw00krx0hvza0qw17vn/subgraphs/uniswap-v3-base/1.0.0/gn
     *
     * Format for hosted subgraphs:
     *   `wss://api.goldsky.com/api/public/<project-id>/subgraphs/<name>/<version>/gn`
     */
    wsEndpoint?: string;

    /** API key sent as `Authorization: Bearer <key>` in `connection_init`.
     * If private endpoints are needed to restrict access to your subgraph
     */
    apiKey?: string;

    /**
     * Builds the per-address GraphQL subscription query sent to the subgraph.
     * Use one of the built-in builders (`POLYMARKET_DEFAULT_SUBSCRIPTION`,
     * `POLYMARKET_TRADES_SUBSCRIPTION`, `LIMITLESS_DEFAULT_SUBSCRIPTION`) or
     * supply a custom one for your schema.
     */
    buildSubscription: GoldSkySubscriptionBuilder;

    /**
     * Optional function to extract partial activity directly from the raw
     * GraphQL subscription event data, avoiding REST/RPC calls for the types
     * it can populate.
     *
     * Pair with the matching subscription builder:
     * - `POLYMARKET_TRADES_SUBSCRIPTION` + `buildPolymarketTradesActivity`
     * - `LIMITLESS_DEFAULT_SUBSCRIPTION` + `buildLimitlessBalanceActivity`
     *
     * Return `null` or omit this field to fall back to a full REST/RPC fetch
     * for every trigger event.
     */
    buildActivity?: ActivityBuilder;

    /**
     * Milliseconds between reconnect attempts after a WebSocket disconnect.
     * @default 5000
     */
    reconnectDelayMs?: number;
}

export interface GoldSkyWatcherConfig extends GoldSkyConfig, Pick<AddressWatcherConfig, "pollMs"> {
}

// ----------------------------------------------------------------------------
// Default subscription builders
// ----------------------------------------------------------------------------

/**
 * Polymarket subscription: watches ERC-1155 `TransferSingle` events on the
 * CTF contract as a heartbeat trigger.
 *
 * This builder does NOT carry enough data to construct trades or positions —
 * use it without a `buildActivity` function to trigger a full Data API
 * re-fetch, or switch to `POLYMARKET_TRADES_SUBSCRIPTION` if you only need
 * trade data and want to avoid the REST call.
 *
 * @example
 * ```ts
 * const exchange = new PolymarketExchange({
 *   goldsky: {
 *     wsEndpoint: 'wss://api.goldsky.com/...',
 *     buildSubscription: POLYMARKET_DEFAULT_SUBSCRIPTION,
 *   },
 * });
 * ```
 */
export const POLYMARKET_DEFAULT_SUBSCRIPTION: GoldSkySubscriptionBuilder = (address) => ({
    query: /* GraphQL */ `
        subscription WatchPolymarketAddress($address: Bytes!) {
            transferSingles(
                where: { or: [{ from: $address }, { to: $address }] }
                first: 1
                orderBy: timestamp
                orderDirection: desc
            ) {
                id
                timestamp
            }
        }
    `,
    variables: { address: address.toLowerCase() },
});

/**
 * Polymarket subscription: watches `OrderFilled` events on the CTF Exchange
 * contract. Carries full trade data (`maker`, `taker`, asset IDs and amounts)
 * so that `buildPolymarketTradesActivity` can construct `Trade[]` directly
 * from the event without a Data API call.
 *
 * Pair with `buildPolymarketTradesActivity` in `GoldSkyConfig.buildActivity`.
 * If you also watch `positions` or `balances`, those types are still fetched
 * via REST/RPC.
 *
 * @example
 * ```ts
 * const exchange = new PolymarketExchange({
 *   goldsky: {
 *     wsEndpoint: 'wss://api.goldsky.com/...',
 *     buildSubscription: POLYMARKET_TRADES_SUBSCRIPTION,
 *     buildActivity: buildPolymarketTradesActivity,
 *     triggerDelayMs: 0,  // data comes directly from the event
 *   },
 * });
 * ```
 */
export const POLYMARKET_TRADES_SUBSCRIPTION: GoldSkySubscriptionBuilder = (address) => ({
    query: /* GraphQL */ `
        subscription WatchPolymarketTrades($address: Bytes!) {
            orderFilleds(
                where: { or: [{ maker: $address }, { taker: $address }] }
                first: 20
                orderBy: timestamp
                orderDirection: desc
            ) {
                id
                timestamp
                maker
                taker
                makerAssetId
                takerAssetId
                makerAmountFilled
                takerAmountFilled
            }
        }
    `,
    variables: { address: address.toLowerCase() },
});

/**
 * Limitless subscription: watches ERC-20 `Transfer` events on the USDC
 * contract. Includes `from`, `to`, and `value` so that
 * `buildLimitlessBalanceActivity` can compute the new balance as a delta
 * from the last known snapshot without a Base RPC call.
 *
 * Pair with `buildLimitlessBalanceActivity` in `GoldSkyConfig.buildActivity`.
 *
 * @example
 * ```ts
 * const exchange = new LimitlessExchange({
 *   goldsky: {
 *     wsEndpoint: 'wss://api.goldsky.com/...',
 *     buildSubscription: LIMITLESS_DEFAULT_SUBSCRIPTION,
 *     buildActivity: buildLimitlessBalanceActivity,
 *     triggerDelayMs: 0,
 *   },
 * });
 * ```
 */
export const LIMITLESS_DEFAULT_SUBSCRIPTION: GoldSkySubscriptionBuilder = (address) => ({
    query: /* GraphQL */ `
        subscription WatchLimitlessAddress($address: Bytes!) {
            transfers(
                where: { or: [{ from: $address }, { to: $address }] }
                first: 1
                orderBy: blockTimestamp
                orderDirection: desc
            ) {
                id
                blockTimestamp
                from
                to
                value
            }
        }
    `,
    variables: { address: address.toLowerCase() },
});

// ----------------------------------------------------------------------------
// Activity builders
// ----------------------------------------------------------------------------

/**
 * Derives `Trade[]` from Polymarket CTF Exchange `OrderFilled` event data.
 *
 * @param data Raw subscription message data
 * @param address Public wallet address watched
 * @param types Watched options
 * @return `null` (falling back to a full Data API fetch) when:
 * - `'trades'` is not in the requested types
 * - The event contains no `orderFilleds` entries
 */
export const buildPolymarketTradesActivity: ActivityBuilder = (data, address, types): WatchedEventActivity | null => {
    if (!types.includes('trades')) return null;
    const filled = (data as any)?.orderFilleds;
    if (!Array.isArray(filled) || filled.length === 0) return null;

    const addr = address.toLowerCase();
    const trades: Trade[] = filled.map((f: any): Trade => {
        const isMaker = (f.maker as string)?.toLowerCase() === addr;
        // assetId == 0 means USDC; anything else is a CTF outcome token
        const currAssetId = BigInt(isMaker ? f.makerAssetId : f.takerAssetId);
        const isBuying = currAssetId === 0n; // spending USDC → is a buy

        // Resolve the CTF share amount and USDC amount based on role and side
        let shareAmount: number;
        let usdcAmount: number;
        if (isMaker) {
            if (isBuying) {
                usdcAmount = Number(BigInt(f.makerAmountFilled)) / 1e6;
                shareAmount = Number(BigInt(f.takerAmountFilled)) / 1e6;
            } else {
                shareAmount = Number(BigInt(f.makerAmountFilled)) / 1e6;
                usdcAmount = Number(BigInt(f.takerAmountFilled)) / 1e6;
            }
        } else {
            if (isBuying) {
                usdcAmount = Number(BigInt(f.takerAmountFilled)) / 1e6;
                shareAmount = Number(BigInt(f.makerAmountFilled)) / 1e6;
            } else {
                shareAmount = Number(BigInt(f.takerAmountFilled)) / 1e6;
                usdcAmount = Number(BigInt(f.makerAmountFilled)) / 1e6;
            }
        }

        return {
            id: f.id,
            timestamp: Number(f.timestamp) * 1000,
            price: shareAmount > 0 ? usdcAmount / shareAmount : 0,
            amount: shareAmount,
            side: isBuying ? 'buy' : 'sell',
            outcomeId: isMaker ? f.makerAssetId : f.takerAssetId,
        };
    });

    return { trades };
};

/**
 * Derives a `Balance` update for USDC from a Limitless ERC-20 transfer event.
 *
 * @param data Raw subscription message data
 * @param address Public wallet address watched
 * @param types Watched options
 * @param lastActivity Last activity snapshot. It can set to be null to force an update.
 * @return `null` (falling back to a full RPC fetch) when:
 * - `'balances'` is not in the requested types
 * - The event contains no `transfers` entries
 * - There is no previous balance snapshot to apply the delta against
 */
export const buildLimitlessBalanceActivity: ActivityBuilder = (data, address, types, lastActivity): WatchedEventActivity | null => {
    if (!types.includes('balances')) return null;
    const transfers = (data as any)?.transfers;
    if (!Array.isArray(transfers) || transfers.length === 0) return null;

    const prev = lastActivity?.balances?.find(b => b.currency === 'USDC');
    if (!prev) return null;

    const t = transfers[0];
    const addr = address.toLowerCase();
    const isIncoming = (t.to as string)?.toLowerCase() === addr;
    const delta = Number(BigInt(t.value)) / 1e6;
    const newTotal = Math.max(0, isIncoming ? prev.total + delta : prev.total - delta);

    return {
        balances: [{
            currency: 'USDC',
            total: newTotal,
            // A transfer does not change locked orders; preserve the previous locked value
            available: Math.max(0, newTotal - prev.locked),
            locked: prev.locked,
        }],
    };
};

// ----------------------------------------------------------------------------
// GoldSkySubscriber
// ----------------------------------------------------------------------------

/**
 * Implements `AddressSubscriber` using a GoldSky (or any compatible)
 * GraphQL endpoint over the `graphql-transport-ws` protocol.
 *
 * A single multiplexed WebSocket connection is shared across all watched
 * addresses. Each address gets its own GraphQL subscription (unique `id`).
 * The connection reconnects automatically and re-subscribes on disconnect.
 *
 * Raw event data from the server is forwarded to the `onEvent` callback so
 * that the caller's `ActivityBuilder` can derive structured data from it.
 *
 * @example
 * ```ts
 * const goldSkySubscriber = new GoldSkySubscriber({
 *   wsEndpoint: 'wss://api.goldsky.com/...',
 *   buildSubscription: POLYMARKET_TRADES_SUBSCRIPTION,
 *   buildActivity: buildPolymarketTradesActivity,
 * });
 * const watcher = new AddressSubscriber(fetchFn, {
 *   goldSkySubscriber,
 *   buildActivity: goldSkySubscriber.config.buildActivity,
 * });
 * ```
 */
export class GoldSkySubscriber implements AddressSubscriber {
    readonly config: GoldSkyConfig;

    // WebSocket state
    private ws?: WebSocket;
    private connected = false;
    private connectPromise?: Promise<void>;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private closed = false;
    private readonly wsEndpoint: string;

    private callbacks = new Map<string, (data: unknown) => void>();   // address → onEvent callback
    private subscriptionIds = new Map<string, string>();               // address → WS subscription id
    private nextId = 1;

    constructor(config: GoldSkyConfig) {
        this.config = config;
        this.wsEndpoint = config.wsEndpoint ?? "https://https://api.goldsky.com/api/public/project_cl8ylkiw00krx0hvza0qw17vn/subgraphs/uniswap-v3-base/1.0.0/gn";
    }

    // --------------------------------------------------------------------------
    // Public methods
    // --------------------------------------------------------------------------

    /**
     * Subscribe to on-chain events for `address`.
     *
     * @param address Public wallet address
     * @param onEvent Callback when a subscribed message arrives
     */
    async subscribe(address: string, onEvent: (data: unknown) => void): Promise<void> {
        if (this.closed) return;

        this.callbacks.set(address, onEvent);

        if (this.connected) {
            if (!this.subscriptionIds.has(address)) {
                this.sendSubscribe(address);
            }
            return;
        }

        await this.connect();
    }

    /** Unsubscribe from events for `address` and send a GraphQL `complete`.
     *
     * @param address Public wallet address
     */
    unsubscribe(address: string): void {
        const id = this.subscriptionIds.get(address);
        if (id && this.ws && this.connected) {
            try {
                this.ws.send(JSON.stringify({ id, type: 'complete' }));
            } catch {
                // WS might be closing — safe to ignore
            }
        }
        this.callbacks.delete(address);
        this.subscriptionIds.delete(address);
    }

    /** Close all subscriptions and the underlying WebSocket. */
    close(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.callbacks.clear();
        this.subscriptionIds.clear();
        this.connected = false;
        this.connectPromise = undefined;
        if (this.ws) {
            try {
                this.ws.close();
            } catch { /* ignore */
            }
            this.ws = undefined;
        }
    }

    // --------------------------------------------------------------------------
    // Private methods
    // --------------------------------------------------------------------------

    /**
     * Open a WebSocket and perform the graphql-transport-ws handshake.
     * Idempotent: returns the existing promise if a connection is in progress.
     */
    private connect(): Promise<void> {
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise<void>((resolve, reject) => {
            const wsEndpoint = this.wsEndpoint;
            const ws = new WebSocket(wsEndpoint, ['graphql-transport-ws']);
            this.ws = ws;

            const connectTimeout = setTimeout(() => {
                ws.terminate();
                this.connectPromise = undefined;
                reject(new Error('[GoldSkySubscriber] Connection timeout'));
            }, 10_000);

            ws.on('open', () => {
                const payload: Record<string, string> = {};
                if (this.config.apiKey) {
                    payload['Authorization'] = `Bearer ${this.config.apiKey}`;
                }
                ws.send(JSON.stringify({ type: 'connection_init', payload }));
            });

            ws.on('message', (raw: WebSocket.RawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return;
                }

                switch (msg.type) {
                    case 'connection_ack':
                        clearTimeout(connectTimeout);
                        this.connected = true;
                        this.connectPromise = undefined;
                        resolve();
                        // Subscribe every registered address with fresh IDs.
                        for (const address of this.callbacks.keys()) {
                            this.sendSubscribe(address);
                        }
                        break;

                    case 'next':
                        if (msg.id) this.handlePayload(msg.id, msg.payload?.data ?? null);
                        break;

                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'error':
                        console.warn('[GoldSkySubscriber] Subscription error:', msg.payload);
                        break;

                    case 'connection_error':
                        // Server rejected connection_init
                        clearTimeout(connectTimeout);
                        this.connectPromise = undefined;
                        reject(new Error(`[GoldSkySubscriber] Server rejected connection: ${JSON.stringify(msg.payload)}`));
                        break;
                }
            });

            ws.on('close', () => {
                clearTimeout(connectTimeout);
                this.connected = false;
                this.ws = undefined;
                this.connectPromise = undefined;
                this.subscriptionIds.clear();

                if (!this.closed && this.callbacks.size > 0) {
                    const delay = this.config.reconnectDelayMs ?? 5000;
                    this.reconnectTimer = setTimeout(() => this.reconnect(), delay);
                }
            });

            ws.on('error', (err: Error) => {
                if (!this.connected) {
                    clearTimeout(connectTimeout);
                    this.connectPromise = undefined;
                    reject(err);
                } else {
                    console.warn('[GoldSkySubscriber] WebSocket error:', err.message);
                }
            });
        });

        return this.connectPromise;
    }

    private async reconnect(): Promise<void> {
        if (this.closed || this.callbacks.size === 0) return;
        try {
            await this.connect();
        } catch {
            const delay = this.config.reconnectDelayMs ?? 5000;
            this.reconnectTimer = setTimeout(() => this.reconnect(), delay);
        }
    }

    private sendSubscribe(address: string): void {
        if (!this.ws || !this.connected) return;
        const id = String(this.nextId++);
        const { query, variables } = this.config.buildSubscription(address);
        this.subscriptionIds.set(address, id);
        try {
            this.ws.send(JSON.stringify({
                id,
                type: 'subscribe',
                payload: { query, variables: variables ?? {} },
            }));
        } catch (err: any) {
            console.warn('[GoldSkySubscriber] Failed to send subscribe:', err.message);
            this.subscriptionIds.delete(address);
        }
    }

    private handlePayload(subscriptionId: string, data: unknown): void {
        for (const [address, id] of this.subscriptionIds.entries()) {
            if (id !== subscriptionId) continue;

            const callback = this.callbacks.get(address);
            if (!callback) break;

            callback(data);
            break;
        }
    }
}
