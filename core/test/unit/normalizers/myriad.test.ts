import { describe, test, expect } from '@jest/globals';
import { MyriadNormalizer } from '../../../src/exchanges/myriad/normalizer';
import {
    MyriadRawMarket,
    MyriadRawOutcome,
    MyriadRawQuestion,
    MyriadRawTradeEvent,
    MyriadRawPortfolioItem,
} from '../../../src/exchanges/myriad/fetcher';
import { OHLCVParams } from '../../../src/BaseExchange';
import { validatePriceCandle } from '../../compliance/shared';

const normalizer = new MyriadNormalizer();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_OUTCOME_YES: MyriadRawOutcome = {
    id: 101,
    title: 'Yes',
    price: 0.65,
    priceChange24h: 0.05,
    price_charts: {
        chart1: {
            timeframe: '24h',
            prices: [
                { value: 0.60, timestamp: 1700000000 },
                { value: 0.62, timestamp: 1700000060 },
                { value: 0.65, timestamp: 1700000120 },
            ],
        },
        chart2: {
            timeframe: '7d',
            prices: [
                { value: 0.55, timestamp: 1699900000 },
                { value: 0.60, timestamp: 1699950000 },
            ],
        },
    },
};

const RAW_OUTCOME_NO: MyriadRawOutcome = {
    id: 102,
    title: 'No',
    price: 0.35,
    priceChange24h: -0.05,
};

const RAW_MARKET: MyriadRawMarket = {
    id: 42,
    networkId: 1,
    title: 'Will ETH merge succeed?',
    description: 'Resolves Yes if the merge completes.',
    slug: 'eth-merge',
    imageUrl: 'https://example.com/eth.png',
    expiresAt: '2025-12-31T00:00:00Z',
    volume24h: 10000,
    volume: 500000,
    liquidity: 8000,
    questionId: 7,
    topics: ['crypto', 'ethereum'],
    outcomes: [RAW_OUTCOME_YES, RAW_OUTCOME_NO],
};

// ---------------------------------------------------------------------------
// normalizeMarket
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeMarket', () => {
    test('should produce a valid UnifiedMarket with composite IDs', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        expect(market).not.toBeNull();

        // Composite ID: networkId:marketId
        expect(market!.marketId).toBe('1:42');
        expect(market!.title).toBe('Will ETH merge succeed?');
        expect(market!.outcomes).toHaveLength(2);

        // Composite outcome IDs: networkId:marketId:outcomeId
        expect(market!.outcomes[0].outcomeId).toBe('1:42:101');
        expect(market!.outcomes[1].outcomeId).toBe('1:42:102');
    });

    test('should map outcome fields correctly', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);

        const yesOutcome = market!.outcomes[0];
        expect(yesOutcome.label).toBe('Yes');
        expect(yesOutcome.price).toBeCloseTo(0.65);
        expect(yesOutcome.priceChange24h).toBeCloseTo(0.05);

        const noOutcome = market!.outcomes[1];
        expect(noOutcome.label).toBe('No');
        expect(noOutcome.price).toBeCloseTo(0.35);
    });

    test('should set volume, liquidity, and resolution date', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        expect(market!.volume24h).toBe(10000);
        expect(market!.volume).toBe(500000);
        expect(market!.liquidity).toBe(8000);
        expect(market!.resolutionDate).toBeInstanceOf(Date);
        expect(market!.resolutionDate.toISOString()).toBe('2025-12-31T00:00:00.000Z');
    });

    test('should set url and tags', () => {
        const market = normalizer.normalizeMarket(RAW_MARKET);
        expect(market!.url).toBe('https://myriad.markets/markets/eth-merge');
        expect(market!.tags).toEqual(['crypto', 'ethereum']);
    });

    test('should return null for null input', () => {
        expect(normalizer.normalizeMarket(null as any)).toBeNull();
    });

    test('should return null for undefined input', () => {
        expect(normalizer.normalizeMarket(undefined as any)).toBeNull();
    });

    test('should handle missing outcomes gracefully', () => {
        const noOutcomes: MyriadRawMarket = {
            id: 99,
            networkId: 1,
            title: 'No outcomes market',
        };
        const market = normalizer.normalizeMarket(noOutcomes);
        expect(market).not.toBeNull();
        expect(market!.outcomes).toHaveLength(0);
    });

    test('should handle missing optional fields', () => {
        const minimal: MyriadRawMarket = {
            id: 55,
            networkId: 2,
            outcomes: [{ id: 1, title: 'A', price: 0.5 }],
        };
        const market = normalizer.normalizeMarket(minimal);
        expect(market).not.toBeNull();
        expect(market!.marketId).toBe('2:55');
        expect(market!.title).toBe('');
    });
});

// ---------------------------------------------------------------------------
// normalizeOHLCV (nested price_charts)
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeOHLCV', () => {
    test('should select 24h timeframe for 1m resolution', () => {
        const params: OHLCVParams = { resolution: '1m' };
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params);

        expect(candles.length).toBe(3);
        // Timestamps converted from seconds to ms
        expect(candles[0].timestamp).toBe(1700000000000);
        expect(candles[0].open).toBeCloseTo(0.60);
    });

    test('should select 7d timeframe for 1h resolution', () => {
        const params: OHLCVParams = { resolution: '1h' };
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params);

        expect(candles.length).toBe(2);
        expect(candles[0].open).toBeCloseTo(0.55);
    });

    test('should select 30d timeframe for 1d resolution', () => {
        const params: OHLCVParams = { resolution: '1d' };
        // No 30d chart in our fixture, so should return empty
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params);
        expect(candles).toHaveLength(0);
    });

    test('should use specific outcomeId when provided', () => {
        const params: OHLCVParams = { resolution: '1m' };
        // Outcome 102 (No) has no price_charts, so should return empty
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params, '102');
        expect(candles).toHaveLength(0);
    });

    test('should respect limit parameter', () => {
        const params: OHLCVParams = { resolution: '1m', limit: 2 };
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params);
        expect(candles).toHaveLength(2);
    });

    test('should validate OHLCV mathematical consistency', () => {
        const params: OHLCVParams = { resolution: '1m' };
        const candles = normalizer.normalizeOHLCV(RAW_MARKET, params);
        for (const c of candles) {
            validatePriceCandle(c, 'Myriad', 'test');
        }
    });

    test('should return empty for market with no outcomes', () => {
        const empty: MyriadRawMarket = { id: 1, networkId: 1 };
        const candles = normalizer.normalizeOHLCV(empty, { resolution: '1m' });
        expect(candles).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// normalizeOrderBook
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeOrderBook', () => {
    test('should generate synthetic order book from outcome price', () => {
        const ob = normalizer.normalizeOrderBook(RAW_MARKET, '1:42:101');

        expect(ob.bids).toHaveLength(1);
        expect(ob.asks).toHaveLength(1);
        expect(ob.bids[0].price).toBeCloseTo(0.65);
        expect(ob.asks[0].price).toBeCloseTo(0.65);
    });

    test('should fall back to first outcome when outcomeId not matched', () => {
        const ob = normalizer.normalizeOrderBook(RAW_MARKET, '1:42:999');
        // Falls back to first outcome (Yes, price=0.65)
        expect(ob.bids[0].price).toBeCloseTo(0.65);
    });

    test('should return empty book for market with no outcomes', () => {
        const empty: MyriadRawMarket = { id: 1, networkId: 1 };
        const ob = normalizer.normalizeOrderBook(empty, '1:1:1');
        expect(ob.bids).toHaveLength(0);
        expect(ob.asks).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// normalizeTrade
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeTrade', () => {
    test('should convert raw trade event to unified Trade', () => {
        const raw: MyriadRawTradeEvent = {
            action: 'buy',
            blockNumber: 12345,
            timestamp: 1700000000,
            value: 50,
            shares: 100,
        };

        const trade = normalizer.normalizeTrade(raw, 0);

        expect(trade.id).toBe('12345-0');
        expect(trade.timestamp).toBe(1700000000000); // seconds → ms
        expect(trade.amount).toBe(100);
        expect(trade.side).toBe('buy');
        // price = value / shares = 50 / 100 = 0.5
        expect(trade.price).toBeCloseTo(0.5);
    });

    test('should map sell action correctly', () => {
        const raw: MyriadRawTradeEvent = {
            action: 'sell',
            timestamp: 1700000000,
            value: 30,
            shares: 100,
        };
        expect(normalizer.normalizeTrade(raw, 1).side).toBe('sell');
    });

    test('should use timestamp in id when blockNumber is missing', () => {
        const raw: MyriadRawTradeEvent = {
            action: 'buy',
            timestamp: 1700000000,
            value: 10,
            shares: 20,
        };
        expect(normalizer.normalizeTrade(raw, 3).id).toBe('1700000000-3');
    });

    test('should handle zero shares gracefully', () => {
        const raw: MyriadRawTradeEvent = {
            action: 'buy',
            timestamp: 1700000000,
            value: 50,
            shares: 0,
        };
        // resolveMyriadPrice uses Math.max(shares, 1) to avoid division by zero
        const trade = normalizer.normalizeTrade(raw, 0);
        expect(trade.price).toBe(50); // value / max(0,1) = 50
    });
});

// ---------------------------------------------------------------------------
// normalizePosition
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizePosition', () => {
    test('should produce composite IDs for position', () => {
        const raw: MyriadRawPortfolioItem = {
            networkId: 1,
            marketId: 42,
            outcomeId: 101,
            outcomeTitle: 'Yes',
            shares: 200,
            price: 0.55,
            profit: 15,
            value: 130,
        };

        const pos = normalizer.normalizePosition(raw);
        expect(pos.marketId).toBe('1:42');
        expect(pos.outcomeId).toBe('1:42:101');
        expect(pos.outcomeLabel).toBe('Yes');
        expect(pos.size).toBe(200);
        expect(pos.entryPrice).toBeCloseTo(0.55);
        // currentPrice = value / shares = 130 / 200 = 0.65
        expect(pos.currentPrice).toBeCloseTo(0.65);
        expect(pos.unrealizedPnL).toBe(15);
    });

    test('should use fallback outcome label', () => {
        const raw: MyriadRawPortfolioItem = {
            networkId: 2,
            marketId: 10,
            outcomeId: 5,
            shares: 50,
        };

        const pos = normalizer.normalizePosition(raw);
        expect(pos.outcomeLabel).toBe('Outcome 5');
    });
});

// ---------------------------------------------------------------------------
// normalizeBalance
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeBalance', () => {
    test('should aggregate portfolio items into single USDC balance', () => {
        const items: MyriadRawPortfolioItem[] = [
            { networkId: 1, marketId: 1, outcomeId: 1, value: 100 },
            { networkId: 1, marketId: 2, outcomeId: 2, value: 250 },
            { networkId: 1, marketId: 3, outcomeId: 3, value: 50 },
        ];

        const balances = normalizer.normalizeBalance(items);
        expect(balances).toHaveLength(1);
        expect(balances[0].currency).toBe('USDC');
        expect(balances[0].total).toBe(400);
        expect(balances[0].locked).toBe(400);
        expect(balances[0].available).toBe(0);
    });

    test('should handle empty portfolio', () => {
        const balances = normalizer.normalizeBalance([]);
        expect(balances).toHaveLength(1);
        expect(balances[0].total).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// normalizeEvent
// ---------------------------------------------------------------------------

describe('MyriadNormalizer.normalizeEvent', () => {
    test('should normalize question into UnifiedEvent', () => {
        const raw: MyriadRawQuestion = {
            id: 7,
            title: 'Ethereum Questions',
            markets: [RAW_MARKET],
        };

        const event = normalizer.normalizeEvent(raw);
        expect(event).not.toBeNull();
        expect(event!.id).toBe('7');
        expect(event!.title).toBe('Ethereum Questions');
        expect(event!.markets).toHaveLength(1);
        expect(event!.volume24h).toBe(10000);
    });

    test('should return null for null input', () => {
        expect(normalizer.normalizeEvent(null as any)).toBeNull();
    });

    test('should handle question with no markets', () => {
        const raw: MyriadRawQuestion = { id: 1, title: 'Empty' };
        const event = normalizer.normalizeEvent(raw);
        expect(event).not.toBeNull();
        expect(event!.markets).toHaveLength(0);
    });
});
