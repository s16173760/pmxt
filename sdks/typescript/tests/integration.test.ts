/**
 * TypeScript SDK Integration Tests
 *
 * These tests verify that the TypeScript SDK correctly communicates with the PMXT server
 * and returns properly structured, validated data.
 *
 * Prerequisites:
 * - PMXT server must be running (use pmxt-ensure-server)
 * - No API keys required for read-only operations
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { Polymarket, Kalshi } from '../index';

let serverAvailable = false;

beforeAll(async () => {
    try {
        const client = new Polymarket();
        await client.fetchMarkets({ limit: 1 });
        serverAvailable = true;
    } catch {
        console.info('[Integration] PMXT server not available, skipping integration tests.');
    }
}, 30000);

describe('Polymarket Integration', () => {
    let client: Polymarket;
    let markets: any[];

    beforeAll(async () => {
        if (!serverAvailable) return;
        client = new Polymarket();
        markets = await client.fetchMarkets({ query: 'election', limit: 5 });
    }, 120000);

    test('fetchMarkets returns valid structure', () => {
        if (!serverAvailable) return;
        expect(Array.isArray(markets)).toBe(true);
        expect(markets.length).toBeGreaterThan(0);

        const market = markets[0];
        expect(market).toHaveProperty('marketId');
        expect(market).toHaveProperty('title');
        expect(market).toHaveProperty('outcomes');
        expect(market).toHaveProperty('volume24h');

        expect(typeof market.marketId).toBe('string');
        expect(typeof market.title).toBe('string');
        expect(Array.isArray(market.outcomes)).toBe(true);
        expect(market.outcomes.length).toBeGreaterThan(0);
    });

    test('market outcomes have required fields', () => {
        if (!serverAvailable) return;
        const outcome = markets[0].outcomes[0];

        expect(outcome).toHaveProperty('label');
        expect(outcome).toHaveProperty('price');
        expect(typeof outcome.label).toBe('string');
        expect(typeof outcome.price).toBe('number');
        expect(outcome.price).toBeGreaterThanOrEqual(0);
        expect(outcome.price).toBeLessThanOrEqual(1);
    });

    test('volume fields are numeric', () => {
        if (!serverAvailable) return;
        const market = markets[0];

        expect(typeof market.volume24h).toBe('number');
        expect(market.volume24h).toBeGreaterThanOrEqual(0);
    });

    test('resolution date is properly typed', () => {
        if (!serverAvailable) return;
        const market = markets[0];

        if (market.resolutionDate) {
            expect(market.resolutionDate instanceof Date || typeof market.resolutionDate === 'string').toBe(true);
        }
    });
});

describe('Kalshi Integration', () => {
    let client: Kalshi;
    let markets: any[];

    beforeAll(async () => {
        if (!serverAvailable) return;
        client = new Kalshi();
        markets = await client.fetchMarkets({ limit: 5 });
    }, 120000);

    test('fetchMarkets returns valid structure', () => {
        if (!serverAvailable) return;
        expect(Array.isArray(markets)).toBe(true);
        expect(markets.length).toBeGreaterThan(0);

        const market = markets[0];
        expect(market).toHaveProperty('marketId');
        expect(market).toHaveProperty('title');
        expect(market).toHaveProperty('outcomes');
    });

    test('market outcomes are properly structured', () => {
        if (!serverAvailable) return;
        const market = markets[0];

        expect(Array.isArray(market.outcomes)).toBe(true);
        expect(market.outcomes.length).toBeGreaterThan(0);

        const outcome = market.outcomes[0];
        expect(outcome).toHaveProperty('label');
        expect(outcome).toHaveProperty('price');
    });
});
