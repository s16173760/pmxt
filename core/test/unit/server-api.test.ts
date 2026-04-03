import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import type { Server } from 'http';
import {
    BadRequest,
    NotFound,
    NetworkError,
    RateLimitExceeded,
    AuthenticationError,
} from '../../src/errors';

const TEST_TOKEN = 'test-token-123';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
// The server uses a module-level singleton cache keyed by exchange name.
// Once a singleton is created, it is reused for all subsequent requests
// without credentials. Therefore we configure a single shared mock instance
// whose individual methods can be swapped between tests.
//
// For tests that need per-request instances (credentials routing), we track
// constructor calls and return fresh objects.
// ---------------------------------------------------------------------------

const mockInstance: Record<string, any> = {
    fetchMarkets: jest.fn().mockResolvedValue([]),
    fetchEvents: jest.fn().mockResolvedValue([]),
    verbose: false,
};

// Constructor mock — returns the shared singleton-like object by default.
// Individual tests can override via mockImplementation.
const polymarketCtor = jest.fn().mockImplementation(() => mockInstance);
const limitlessCtor = jest.fn().mockImplementation(() => mockInstance);
const kalshiCtor = jest.fn().mockImplementation(() => mockInstance);
const kalshiDemoCtor = jest.fn().mockImplementation(() => mockInstance);
const probableCtor = jest.fn().mockImplementation(() => mockInstance);
const baoziCtor = jest.fn().mockImplementation(() => mockInstance);
const myriadCtor = jest.fn().mockImplementation(() => mockInstance);

jest.mock('../../src/exchanges/polymarket', () => ({
    PolymarketExchange: polymarketCtor,
}));
jest.mock('../../src/exchanges/limitless', () => ({
    LimitlessExchange: limitlessCtor,
}));
jest.mock('../../src/exchanges/kalshi', () => ({
    KalshiExchange: kalshiCtor,
}));
jest.mock('../../src/exchanges/kalshi-demo', () => ({
    KalshiDemoExchange: kalshiDemoCtor,
}));
jest.mock('../../src/exchanges/probable', () => ({
    ProbableExchange: probableCtor,
}));
jest.mock('../../src/exchanges/baozi', () => ({
    BaoziExchange: baoziCtor,
}));
jest.mock('../../src/exchanges/myriad', () => ({
    MyriadExchange: myriadCtor,
}));

// Suppress console.error noise from the Express error handler
jest.spyOn(console, 'error').mockImplementation(() => {});

import { startServer } from '../../src/server/app';

let server: Server;

beforeAll(async () => {
    server = await startServer(0, TEST_TOKEN) as unknown as Server;
});

afterAll(() => {
    server?.close();
});

beforeEach(() => {
    // Reset method mocks but do NOT clear constructor mocks (singleton already cached)
    mockInstance.fetchMarkets = jest.fn().mockResolvedValue([]);
    mockInstance.fetchEvents = jest.fn().mockResolvedValue([]);
    mockInstance.verbose = false;
});

// ---------------------------------------------------------------------------
// 1. Health check
// ---------------------------------------------------------------------------
describe('Health check', () => {
    test('GET /health returns status ok with timestamp', async () => {
        const res = await request(server).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(typeof res.body.timestamp).toBe('number');
    });

    test('GET /health does not require auth token', async () => {
        const res = await request(server).get('/health');
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 2. Authentication middleware
// ---------------------------------------------------------------------------
describe('Authentication middleware', () => {
    test('request without token returns 401', async () => {
        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .send({ args: [] });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            success: false,
            error: 'Unauthorized: Invalid or missing access token',
        });
    });

    test('request with wrong token returns 401', async () => {
        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', 'wrong-token')
            .send({ args: [] });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test('request with correct token passes through', async () => {
        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 3. Route validation
// ---------------------------------------------------------------------------
describe('Route validation', () => {
    test('nonexistent method returns 404', async () => {
        const res = await request(server)
            .post('/api/polymarket/nonExistentMethod')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            success: false,
            error: "Method 'nonExistentMethod' not found on polymarket",
        });
    });

    test('unknown exchange returns 500 with error message', async () => {
        const res = await request(server)
            .post('/api/unknownexchange/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toBe('Unknown exchange: unknownexchange');
    });
});

// ---------------------------------------------------------------------------
// 4. Successful method dispatch
// ---------------------------------------------------------------------------
describe('Successful method dispatch', () => {
    test('returns mocked data with success true and status 200', async () => {
        const fakeMarkets = [{ id: '1', name: 'Test Market' }];
        mockInstance.fetchMarkets = jest.fn().mockResolvedValue(fakeMarkets);

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [{ limit: 5 }] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: fakeMarkets });
    });

    test('args are spread correctly to the exchange method', async () => {
        const fetchMarketsFn = jest.fn().mockResolvedValue([]);
        mockInstance.fetchMarkets = fetchMarketsFn;

        await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [{ limit: 5 }] });

        expect(fetchMarketsFn).toHaveBeenCalledWith({ limit: 5 });
    });

    test('empty args defaults to empty array', async () => {
        const fetchMarketsFn = jest.fn().mockResolvedValue([]);
        mockInstance.fetchMarkets = fetchMarketsFn;

        await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({});

        expect(fetchMarketsFn).toHaveBeenCalledWith();
    });
});

// ---------------------------------------------------------------------------
// 5. Error handling - BaseError instances
// ---------------------------------------------------------------------------
describe('Error handling - BaseError instances', () => {
    test('BadRequest returns 400', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new BadRequest('bad param', 'polymarket'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toBe('bad param');
        expect(res.body.error.code).toBe('BAD_REQUEST');
        expect(res.body.error.retryable).toBe(false);
    });

    test('RateLimitExceeded returns 429 with retryAfter', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new RateLimitExceeded('slow down', 30, 'polymarket'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(429);
        expect(res.body.error.retryAfter).toBe(30);
        expect(res.body.error.retryable).toBe(true);
    });

    test('NotFound returns 404', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new NotFound('nope'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('NetworkError returns 503 with retryable true', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new NetworkError('timeout'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(503);
        expect(res.body.error.retryable).toBe(true);
        expect(res.body.error.code).toBe('NETWORK_ERROR');
    });

    test('AuthenticationError returns 401', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new AuthenticationError('bad key'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('AUTHENTICATION_ERROR');
    });

    test('exchange field is included when error has it', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new BadRequest('bad param', 'polymarket'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.body.error.exchange).toBe('polymarket');
    });
});

// ---------------------------------------------------------------------------
// 6. Error handling - generic errors
// ---------------------------------------------------------------------------
describe('Error handling - generic errors', () => {
    test('generic Error returns 500', async () => {
        mockInstance.fetchMarkets = jest.fn().mockRejectedValue(
            new Error('kaboom'),
        );

        const res = await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toBe('kaboom');
    });
});

// ---------------------------------------------------------------------------
// 7. Verbose header
// ---------------------------------------------------------------------------
describe('Verbose header', () => {
    test('x-pmxt-verbose true sets exchange.verbose to true', async () => {
        let capturedVerbose: boolean | undefined;
        mockInstance.fetchMarkets = jest.fn().mockImplementation(() => {
            capturedVerbose = mockInstance.verbose;
            return Promise.resolve([]);
        });

        await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .set('x-pmxt-verbose', 'true')
            .send({ args: [] });

        expect(capturedVerbose).toBe(true);
    });

    test('absent verbose header sets exchange.verbose to false', async () => {
        let capturedVerbose: boolean | undefined;
        mockInstance.verbose = true; // start true to verify it gets reset
        mockInstance.fetchMarkets = jest.fn().mockImplementation(() => {
            capturedVerbose = mockInstance.verbose;
            return Promise.resolve([]);
        });

        await request(server)
            .post('/api/polymarket/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        expect(capturedVerbose).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 8. Credentials routing
// ---------------------------------------------------------------------------
describe('Credentials routing', () => {
    test('credentials in body creates a new exchange instance each time', async () => {
        // Use a different exchange (kalshi) to avoid polymarket's cached singleton
        const initialCalls = kalshiCtor.mock.calls.length;

        await request(server)
            .post('/api/kalshi/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [], credentials: { apiKey: 'key-1' } });

        await request(server)
            .post('/api/kalshi/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [], credentials: { apiKey: 'key-2' } });

        // Each credentialed request creates a new instance
        expect(kalshiCtor.mock.calls.length - initialCalls).toBe(2);
    });

    test('no credentials reuses singleton instance', async () => {
        // Use baozi which has not been used yet — no cached singleton
        const initialCalls = baoziCtor.mock.calls.length;

        await request(server)
            .post('/api/baozi/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        await request(server)
            .post('/api/baozi/fetchMarkets')
            .set('x-pmxt-access-token', TEST_TOKEN)
            .send({ args: [] });

        // Singleton: constructor called only once for initial creation
        expect(baoziCtor.mock.calls.length - initialCalls).toBe(1);
    });
});
