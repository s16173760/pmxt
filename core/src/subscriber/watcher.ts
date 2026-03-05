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
     * Subscriber. Responsible for polling or pushing on-chain events
     * for each watched address. When an event arrives, the watcher fetches only
     * the activity types that could not be derived from the event data.
     */
    subscriber: BaseSubscriber;

    /**
     * Optional function to extract partial activity directly from the raw
     * subscription event data, avoiding REST/RPC calls for the types
     * it can populate.
     *
     * Pair with the matching subscription builder in GoldSkySubscriber:
     * - `POLYMARKET_TRADES_SUBSCRIPTION` + `buildPolymarketTradesActivity`
     * - `LIMITLESS_DEFAULT_SUBSCRIPTION` + `buildLimitlessBalanceActivity`
     *
     * Return `null` to fall back to a full REST/RPC fetch for every event.
     */
    buildActivity?: SubscribedActivityBuilder;
}

export interface WatcherConfig extends Omit<SubscriberConfig, "buildSubscription"> {
}


// ----------------------------------------------------------------------------
// AddressWatcher Class
// ----------------------------------------------------------------------------

/**
 * Resolves waiting promises whenever a subscriber reports an on-chain change.
 *
 * The watcher is purely reactive — it does not poll on its own. The supplied
 * `BaseSubscriber` is responsible for all polling or push delivery. When the
 * subscriber fires an event, the watcher:
 * - Calls `buildActivity` to derive what it can from the raw event data.
 * - Fetches only the missing types via `fetchFn` (REST/RPC).
 * - Dispatches to any waiting `watch()` promises if the snapshot changed.
 *
 * CCXT Pro streaming pattern:
 * - First `watch()` call → initial snapshot returned immediately via `fetchFn`.
 * - Subsequent calls → block until the next subscriber-driven update.
 */
export class AddressWatcher {
    private lastState = new Map<string, SubscribedAddressSnapshot>();
    private watchedTypes = new Map<string, SubscriptionOption[]>();
    private assetIdResolvers = new Map<string, QueuedPromise<Trade[]>[]>();
    private resolvers = new Map<string, QueuedPromise<SubscribedAddressSnapshot>[]>();

    private readonly fetchFn: FetchFn;
    private readonly subscriber: BaseSubscriber;
    private readonly buildActivity?: SubscribedActivityBuilder;

    constructor(fetchFn: FetchFn, config: AddressWatcherConfig) {
        this.fetchFn = fetchFn;
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

            await this.subscriber.subscribe(address, (data) => this.handleSubscriptionData(address, data));

            const initial = await this.fetchFn(address, types);
            this.lastState.set(key, initial);

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

        try {
            const lastActivity = this.lastState.get(key);
            const partial = this.buildActivity
                ? this.buildActivity(data, address, types, lastActivity)
                : null;

            let merged: SubscribedAddressSnapshot;
            if (partial === null) {
                // No buildActivity or it returned null — full fetch for all types.
                merged = await this.fetchFn(address, types);
            } else {
                const missingTypes = types.filter(t => !(t in partial)) as SubscriptionOption[];
                if (missingTypes.length > 0) {
                    const fetched = await this.fetchFn(address, missingTypes);
                    merged = { ...fetched, ...partial, address, timestamp: Date.now() };
                } else {
                    merged = { address, timestamp: Date.now(), ...partial };
                }
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
