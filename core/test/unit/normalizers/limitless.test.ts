import { describe, test, expect } from '@jest/globals';
import { LimitlessNormalizer } from '../../../src/exchanges/limitless/normalizer';
import {
    LimitlessRawMarket,
    LimitlessRawPricePoint,
    LimitlessRawOrderBook,
    LimitlessRawTrade,
} from '../../../src/exchanges/limitless/fetcher';
import { OHLCVParams } from '../../../src/BaseExchange';
import { validatePriceCandle, validateOrderBook } from '../../compliance/shared';

const normalizer = new LimitlessNormalizer();

// USDC scaling constant (6 decimals)
const USDC_SCALE = 1_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_MARKET: LimitlessRawMarket = {
    slug: 'will-btc-hit-100k',
    title: 'Will BTC hit $100k?',
    description: 'Resolves Yes if Bitcoin reaches $100,000.',
    tokens: { no: 'token-no-1', yes: 'token-yes-1' },
    prices: [0.35, 0.65],
    expirationTimestamp: '2025-12-31T00:00:00Z',
    volumeFormatted: 42000,
    volume: 500000,
    logo: 'https://example.com/btc.png',
    categories: ['crypto'],
    tags: ['bitcoin', 'price'],
};

// ---------------------------------------------------------------------------
// normalizeMarket
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizeMarket', () => {
    test('should produce a valid UnifiedMarket from a realistic raw market', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        expect(market).not.toBeNull();

        expect(typeof market!.marketId).toBe('string');
        expect(market!.marketId).toBe('will-btc-hit-100k');
        expect(market!.title).toBe('Will BTC hit $100k?');
        expect(market!.outcomes).toHaveLength(2);

        for (const o of market!.outcomes) {
            expect(typeof o.outcomeId).toBe('string');
            expect(o.outcomeId.length).toBeGreaterThan(0);
            expect(typeof o.label).toBe('string');
            expect(typeof o.price).toBe('number');
            expect(o.price).toBeGreaterThanOrEqual(0);
            expect(o.price).toBeLessThanOrEqual(1);
        }

        expect(market!.resolutionDate).toBeInstanceOf(Date);
        expect(isNaN(market!.resolutionDate.getTime())).toBe(false);
        expect(market!.volume24h).toBe(42000);
        expect(market!.url).toMatch(/^https:\/\//);
    });

    test('should capitalize outcome labels from tokens keys', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        const labels = market!.outcomes.map(o => o.label);
        expect(labels).toContain('No');
        expect(labels).toContain('Yes');
    });

    test('should map token IDs to outcomeIds', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        const ids = market!.outcomes.map(o => o.outcomeId);
        expect(ids).toContain('token-no-1');
        expect(ids).toContain('token-yes-1');
    });

    test('should return null for null input', () => {
        expect(normalizer.normalizeMarket(null as any)).toBeNull();
    });

    test('should return null for undefined input', () => {
        expect(normalizer.normalizeMarket(undefined as any)).toBeNull();
    });

    test('should handle missing tokens gracefully', () => {
        const noTokens: LimitlessRawMarket = {
            slug: 'no-tokens',
            title: 'No tokens market',
        };
        const market = normalizer.normalizeMarket(noTokens);
        expect(market).not.toBeNull();
        expect(market!.outcomes).toHaveLength(0);
    });

    test('should handle missing optional fields without crashing', () => {
        const minimal: LimitlessRawMarket = {
            slug: 'minimal',
            tokens: { yes: 'y', no: 'n' },
            prices: [0.5, 0.5],
        };
        const market = normalizer.normalizeMarket(minimal);
        expect(market).not.toBeNull();
        expect(market!.outcomes).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// normalizeOrderBook (with USDC decimal scaling)
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizeOrderBook', () => {
    test('should scale raw USDC sizes by 10^6', () => {
        const raw: LimitlessRawOrderBook = {
            bids: [
                { price: 0.60, size: 2_000_000 },
                { price: 0.50, size: 1_000_000 },
            ],
            asks: [
                { price: 0.65, size: 3_000_000 },
                { price: 0.70, size: 500_000 },
            ],
        };

        const ob = normalizer.normalizeOrderBook(raw, 'test-id');

        // USDC scaling: 2_000_000 / 10^6 = 2.0
        expect(ob.bids[0].size).toBeCloseTo(2.0);
        expect(ob.bids[1].size).toBeCloseTo(1.0);
        expect(ob.asks[0].size).toBeCloseTo(3.0);
        expect(ob.asks[1].size).toBeCloseTo(0.5);
    });

    test('should sort bids descending and asks ascending', () => {
        const raw: LimitlessRawOrderBook = {
            bids: [
                { price: 0.40, size: 1_000_000 },
                { price: 0.60, size: 1_000_000 },
                { price: 0.50, size: 1_000_000 },
            ],
            asks: [
                { price: 0.80, size: 1_000_000 },
                { price: 0.65, size: 1_000_000 },
                { price: 0.70, size: 1_000_000 },
            ],
        };

        const ob = normalizer.normalizeOrderBook(raw, 'test-id');

        expect(ob.bids[0].price).toBe(0.6);
        expect(ob.bids[1].price).toBe(0.5);
        expect(ob.bids[2].price).toBe(0.4);

        expect(ob.asks[0].price).toBe(0.65);
        expect(ob.asks[1].price).toBe(0.7);
        expect(ob.asks[2].price).toBe(0.8);
    });

    test('should handle empty bids/asks', () => {
        const raw: LimitlessRawOrderBook = { bids: [], asks: [] };
        const ob = normalizer.normalizeOrderBook(raw, 'id');
        expect(ob.bids).toHaveLength(0);
        expect(ob.asks).toHaveLength(0);
    });

    test('should handle string price/size values', () => {
        const raw: LimitlessRawOrderBook = {
            bids: [{ price: '0.55' as any, size: '1500000' as any }],
            asks: [{ price: '0.60' as any, size: '2000000' as any }],
        };
        const ob = normalizer.normalizeOrderBook(raw, 'id');
        expect(ob.bids[0].price).toBe(0.55);
        expect(ob.bids[0].size).toBeCloseTo(1.5);
        expect(ob.asks[0].price).toBe(0.6);
        expect(ob.asks[0].size).toBeCloseTo(2.0);
    });
});

// ---------------------------------------------------------------------------
// normalizeTrade (throws)
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizeTrade', () => {
    test('should throw error (not supported)', () => {
        expect(() => normalizer.normalizeTrade({}, 0)).toThrow(/not supported/i);
    });
});

// ---------------------------------------------------------------------------
// normalizeUserTrade
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizeUserTrade', () => {
    test('should parse createdAt ISO string into timestamp', () => {
        const raw: LimitlessRawTrade = {
            id: 'ut-1',
            createdAt: '2025-06-01T12:00:00Z',
            price: '0.70',
            quantity: '100',
            side: 'BUY',
            orderId: 'ord-1',
        };

        const trade = normalizer.normalizeUserTrade(raw, 0);
        expect(trade.id).toBe('ut-1');
        expect(trade.timestamp).toBe(new Date('2025-06-01T12:00:00Z').getTime());
        expect(trade.price).toBeCloseTo(0.7);
        expect(trade.amount).toBe(100);
        expect(trade.side).toBe('buy');
        expect(trade.orderId).toBe('ord-1');
    });

    test('should fall back to numeric timestamp when createdAt is missing', () => {
        const raw: LimitlessRawTrade = {
            id: 'ut-2',
            timestamp: 1700000000000,
            price: '0.40',
            amount: '50',
            side: 'sell',
        };

        const trade = normalizer.normalizeUserTrade(raw, 0);
        expect(trade.timestamp).toBe(1700000000000);
        expect(trade.amount).toBe(50);
        expect(trade.side).toBe('sell');
    });

    test('should use quantity field over amount', () => {
        const raw: LimitlessRawTrade = {
            price: '0.50',
            quantity: '75',
            amount: '25',
            side: 'buy',
        };
        const trade = normalizer.normalizeUserTrade(raw, 0);
        expect(trade.amount).toBe(75);
    });
});

// ---------------------------------------------------------------------------
// normalizeOHLCV
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizeOHLCV', () => {
    const points: LimitlessRawPricePoint[] = [
        { price: 0.5, timestamp: 1700000000000 },
        { price: 0.55, timestamp: 1700003600000 },
        { price: 0.45, timestamp: 1700007200000 },
        { price: 0.60, timestamp: 1700010800000 },
    ];

    const params: OHLCVParams = { resolution: '1h' };

    test('should produce candles sorted by timestamp ascending', () => {
        const candles = normalizer.normalizeOHLCV(points, params);
        for (let i = 1; i < candles.length; i++) {
            expect(candles[i].timestamp).toBeGreaterThanOrEqual(candles[i - 1].timestamp);
        }
    });

    test('should respect limit parameter', () => {
        const candles = normalizer.normalizeOHLCV(points, { resolution: '1h', limit: 2 });
        expect(candles).toHaveLength(2);
    });

    test('should filter by start date', () => {
        const candles = normalizer.normalizeOHLCV(points, {
            resolution: '1h',
            start: new Date(1700003600000),
        });
        expect(candles.length).toBeGreaterThan(0);
        for (const c of candles) {
            expect(c.timestamp).toBeGreaterThanOrEqual(1700003600000);
        }
    });

    test('should filter by end date', () => {
        const candles = normalizer.normalizeOHLCV(points, {
            resolution: '1h',
            end: new Date(1700007200000),
        });
        for (const c of candles) {
            expect(c.timestamp).toBeLessThanOrEqual(1700007200000);
        }
    });

    test('should handle empty input', () => {
        const candles = normalizer.normalizeOHLCV([], params);
        expect(candles).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// normalizePosition
// ---------------------------------------------------------------------------

describe('LimitlessNormalizer.normalizePosition', () => {
    test('should map nested market.slug to marketId', () => {
        const raw = {
            market: { slug: 'btc-100k' },
            asset: 'token-yes',
            outcome: 'Yes',
            size: '200',
            avgPrice: '0.55',
            curPrice: '0.70',
            cashPnl: '30',
            realizedPnl: '10',
        };

        const pos = normalizer.normalizePosition(raw);
        expect(pos.marketId).toBe('btc-100k');
        expect(pos.outcomeId).toBe('token-yes');
        expect(pos.outcomeLabel).toBe('Yes');
        expect(pos.size).toBe(200);
        expect(pos.entryPrice).toBeCloseTo(0.55);
        expect(pos.currentPrice).toBeCloseTo(0.7);
    });

    test('should fall back to conditionId when market.slug is missing', () => {
        const raw = {
            conditionId: 'cond-abc',
            asset: 'token-no',
            size: '50',
            avgPrice: '0.40',
        };

        const pos = normalizer.normalizePosition(raw);
        expect(pos.marketId).toBe('cond-abc');
    });
});
