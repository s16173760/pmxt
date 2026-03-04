import { Balance, Position, QueuedPromise, Trade } from '../types';
import {
    BaseSubscriber,
    SubscribedActivityBuilder,
    SubscribedAddressSnapshot,
    SubscriberConfig,
    SubscriptionOption
} from "./base";

export type FetchFn = (address: string, types: SubscriptionOption[]) => Promise<SubscribedAddressSnapshot>;


// ----------------------------------------------------------------------------
// Configs
// ----------------------------------------------------------------------------

export interface AddressWatcherConfig {
    /**
     * Polling interval when no GraphQl subscription is configured.
     * @default 3000
     */
    pollMs?: number;
    /**
     * Optional subscriber. When provided, the watcher stops polling at
     * `pollMs` intervals and calls `subscriber.subscribe()` for each address so
     * that on-chain events can be delivered immediately.
     */
    subscriber?: BaseSubscriber;

    /**
     * Optional function to extract partial activity directly from the raw
     * subscription event data, avoiding REST/RPC calls for the types
     * it can populate.
     *
     * Pair with the matching subscription builder in GoldSkySubscriber:
     * - `POLYMARKET_TRADES_SUBSCRIPTION` + `buildPolymarketTradesActivity`
     * - `LIMITLESS_DEFAULT_SUBSCRIPTION` + `buildLimitlessBalanceActivity`
     *
     * Return `null` or omit this field to fall back to a full REST/RPC fetch
     * for every trigger event.
     */
    buildActivity?: SubscribedActivityBuilder;
}

export interface WatcherConfig extends Omit<SubscriberConfig, "buildSubscription">,
    Pick<AddressWatcherConfig, "pollMs"> {
}


// ----------------------------------------------------------------------------
// AddressWatcher Class
// ----------------------------------------------------------------------------

/**
 * Subscribes to address-level activity or polls an exchange's REST endpoints when a
 * subscriber is not available. And it resolves waiting promises whenever a change is
 * detected.
 *
 * When an `BaseSubscriber` is supplied the watcher is push-driven:
 * - The subscription fires immediately on on-chain events, bypassing the poll interval.
 * - If a `buildActivity` function is also supplied, the watcher first tries to
 *   construct a partial `SubscribedAddressSnapshot` from the raw event data. Only the
 *   types that cannot be derived from the event are fetched via REST/RPC.
 *
 * Without a subscriber, the watcher polls every `pollMs` milliseconds.
 *
 * Both modes follow the CCXT Pro streaming pattern:
 * - First `watch()` call → initial snapshot returned immediately.
 * - Subsequent calls → block until the next detected change.
 */
export class AddressWatcher {
    private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
    private lastState = new Map<string, SubscribedAddressSnapshot>();
    private watchedTypes = new Map<string, SubscriptionOption[]>();
    private assetIdResolvers = new Map<string, QueuedPromise<Trade[]>[]>();
    private resolvers = new Map<string, QueuedPromise<SubscribedAddressSnapshot>[]>();

    private readonly pollMs: number;
    private readonly fetchFn: FetchFn;
    private readonly subscriber?: BaseSubscriber;
    private readonly buildActivity?: SubscribedActivityBuilder;

    constructor(fetchFn: FetchFn, config: AddressWatcherConfig = {}) {
        this.fetchFn = fetchFn;
        this.pollMs = config.pollMs ?? 3000;
        this.subscriber = config.subscriber;
        this.buildActivity = config.buildActivity;
    }

    /**
     * Watch an address for activity changes (CCXT Pro pattern).
     *
     * @param address - Public wallet address to watch
     * @param types - Subset of activity to watch
     * @param assetId - Optional asset id to filter activity changes.
     * @returns Promise that resolves with the latest SubscribedAddressSnapshot snapshot
     */
    watch(address: string, types: SubscriptionOption[], assetId: string): Promise<Trade[]>;
    watch(address: string, types: SubscriptionOption[]): Promise<SubscribedAddressSnapshot>;
    async watch(address: string, types: SubscriptionOption[], assetId?: string): Promise<SubscribedAddressSnapshot | Trade[]> {
        const key = address.toLowerCase();

        if (!this.watchedTypes.has(key)) {
            this.watchedTypes.set(key, types);

            let needTimer = true;
            if (this.subscriber) {
                try {
                    await this.subscriber.subscribe(address, (data) => this.handleSubscriptionData(address, data));
                    needTimer = false;
                } catch (err: any) {
                    console.warn(
                        `[BaseSubscriber] Address subscription failed for ${address}, ` +
                        `falling back to polling only with interval ${this.pollMs}: ${err?.message ?? err}`,
                    );
                }
            }

            const initial = await this.fetchFn(address, types);
            this.lastState.set(key, initial);

            if (needTimer) {
                const timer = setInterval(() => this.poll(address), this.pollMs);
                this.pollTimers.set(key, timer);
            }

            if (assetId) {
                return initial.trades?.filter(t => t.outcomeId === assetId) ?? [];
            }
            return initial;
        }

        // Address already watched — merge any new types into the polling set
        const currTypes = this.watchedTypes.get(key)!;
        this.watchedTypes.set(key, [...new Set([...currTypes, ...types])]);

        if (assetId) {
            const assetKey = `${key} ${assetId}`;
            return new Promise<Trade[]>((resolve, reject) => {
                if (!this.assetIdResolvers.has(assetKey)) {
                    this.assetIdResolvers.set(assetKey, []);
                }
                this.assetIdResolvers.get(assetKey)!.push({ resolve, reject });
            });
        }

        return new Promise<SubscribedAddressSnapshot>((resolve, reject) => {
            if (!this.resolvers.has(key)) {
                this.resolvers.set(key, []);
            }
            this.resolvers.get(key)!.push({ resolve, reject });
        });
    }

    /**
     * Stop watching an address, cancel its poll timer, unsubscribe from the
     * subscriber, and reject any pending callers.
     *
     * @param address - Public wallet address to unwatch
     */
    unwatch(address: string): void {
        const key = address.toLowerCase();

        const timer = this.pollTimers.get(key);
        if (timer) {
            clearInterval(timer);
            this.pollTimers.delete(key);
        }

        this.subscriber?.unsubscribe(address);

        const resolvers = this.resolvers.get(key);
        if (resolvers) {
            resolvers.forEach(r => r.reject(new Error(`Stopped watching ${address}`)));
            this.resolvers.delete(key);
        }

        this.lastState.delete(key);
        this.watchedTypes.delete(key);

        for (const [k, v] of this.assetIdResolvers.entries()) {
            if (k.startsWith(`${key} `)) {
                v.forEach((r) => r.reject(new Error(`Stopped watching ${address}`)));
                this.assetIdResolvers.delete(k);
            }
        }
    }

    /** Stop all active watchers and close the underlying trigger. */
    close(): void {
        for (const address of [...this.watchedTypes.keys()]) {
            this.unwatch(address);
        }
        this.subscriber?.close();
    }

    /**
     * Handle raw event data from the subscriber.
     *
     * @param address - Public wallet address to watch
     * @param data - Subset of activity to watch
     *
     * Calls `buildActivity` to attempt constructing a partial result from the
     * event payload. Fetches only the types that are missing from the partial,
     * then resolves any waiting promises if a change is detected.
     *
     * Falls back to a full `poll()` when no `buildActivity` is configured or
     * when it returns `null`.
     */
    private async handleSubscriptionData(address: string, data: unknown): Promise<void> {
        const key = address.toLowerCase();
        const types = this.watchedTypes.get(key);
        if (!types) return;

        const lastActivity = this.lastState.get(key);
        const partial = this.buildActivity
            ? this.buildActivity(data, address, types, lastActivity)
            : null;

        if (partial === null) {
            return this.poll(address);
        }

        try {
            const missingTypes = types.filter(t => !(t in partial)) as SubscriptionOption[];
            let merged: SubscribedAddressSnapshot;

            if (missingTypes.length > 0) {
                const fetched = await this.fetchFn(address, missingTypes);
                merged = { ...fetched, ...partial, address, timestamp: Date.now() };
            } else {
                // All types derived from event — no REST/RPC call needed
                merged = { address, timestamp: Date.now(), ...partial };
            }

            const last = this.lastState.get(key);
            if (!last || this.activitiesChanged(last, merged)) {
                this.lastState.set(key, merged);
                const resolvers = this.resolvers.get(key);
                if (resolvers?.length) {
                    resolvers.forEach(r => r.resolve(merged));
                    this.resolvers.set(key, []);
                }
                this.dispatchAssetResolvers(key, merged);
            }
        } catch {
        }
    }

    /**
     * Fetch current state.
     *
     * @param address - Public wallet address to watch
     *
     * Protected against concurrent execution for the same address.
     */
    private async poll(address: string): Promise<void> {
        const key = address.toLowerCase();
        const types = this.watchedTypes.get(key);
        if (!types) return;

        try {
            const current = await this.fetchFn(address, types);
            const last = this.lastState.get(key);

            if (!last || this.activitiesChanged(last, current)) {
                this.lastState.set(key, current);
                const resolvers = this.resolvers.get(key);
                if (resolvers && resolvers.length > 0) {
                    resolvers.forEach(r => r.resolve(current));
                    this.resolvers.set(key, []);
                }
                this.dispatchAssetResolvers(key, current);
            }
        } catch {
        }
    }

    private dispatchAssetResolvers(addrKey: string, activity: SubscribedAddressSnapshot): void {
        for (const [assetKey, resolvers] of this.assetIdResolvers) {
            if (!assetKey.startsWith(`${addrKey} `) || !resolvers.length) continue;
            const assetId = assetKey.slice(addrKey.length + 1);
            const matching = (activity.trades ?? []).filter(t => t.outcomeId === assetId);
            if (matching.length > 0) {
                resolvers.forEach(r => r.resolve(matching));
                this.assetIdResolvers.set(assetKey, []);
            }
        }
    }

    private activitiesChanged(prev: SubscribedAddressSnapshot, curr: SubscribedAddressSnapshot): boolean {
        // Trades: count or most-recent ID changed
        if (prev.trades !== undefined && curr.trades !== undefined) {
            if (prev.trades.length !== curr.trades.length) return true;
            if (prev.trades.length > 0 && prev.trades[0].id !== curr.trades[0].id) return true;
        } else if (prev.trades !== undefined || curr.trades !== undefined) {
            return true;
        }

        // Positions: count or any (marketId, size) pair changed
        if (prev.positions !== undefined && curr.positions !== undefined) {
            if (prev.positions.length !== curr.positions.length) return true;
            const sort = (ps: Position[]) =>
                [...ps].sort((a, b) => a.marketId.localeCompare(b.marketId));
            const sp = sort(prev.positions);
            const sc = sort(curr.positions);
            for (let i = 0; i < sp.length; i++) {
                if (sp[i].marketId !== sc[i].marketId || sp[i].size !== sc[i].size) return true;
            }
        } else if (prev.positions !== undefined || curr.positions !== undefined) {
            return true;
        }

        // Balances: count or any total changed
        if (prev.balances !== undefined && curr.balances !== undefined) {
            if (prev.balances.length !== curr.balances.length) return true;
            const sort = (bs: Balance[]) =>
                [...bs].sort((a, b) => a.currency.localeCompare(b.currency));
            const sb = sort(prev.balances);
            const cb = sort(curr.balances);
            for (let i = 0; i < sb.length; i++) {
                if (sb[i].total !== cb[i].total) return true;
            }
        } else if (prev.balances !== undefined || curr.balances !== undefined) {
            return true;
        }

        return false;
    }
}
