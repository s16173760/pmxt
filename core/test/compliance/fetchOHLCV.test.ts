import { exchangeClasses, validatePriceCandle, initExchange, isSkippableError } from './shared';

describe('Compliance: fetchOHLCV', () => {
    test.each(exchangeClasses)('$name should comply with fetchOHLCV standards', async ({ name, cls }) => {
        const exchange = initExchange(name, cls);

        try {
            console.info(`[Compliance] Testing ${name}.fetchOHLCV`);

            // Fetch markets sorted by volume.  Some exchanges (e.g. Probable)
            // make per-outcome API calls during fetchMarkets, so we keep the
            // limit reasonable to avoid timeouts while still scanning enough.
            const markets = await exchange.fetchMarkets({ limit: 25, sort: 'volume' });
            if (!markets || markets.length === 0) {
                throw new Error(`${name}: No markets found to test fetchOHLCV`);
            }

            let candles: any[] = [];
            let lastError: Error | undefined;
            let testedOutcomeId = '';
            let foundData = false;

            // Sort markets by volume (descending) to prioritise active ones
            const activeMarkets = [...markets].sort((a: any, b: any) => (b.volume24h || b.volume || 0) - (a.volume24h || a.volume || 0));

            // Try multiple resolutions — some exchanges only have daily data.
            // Coarsest first: daily data is most likely to exist.
            const resolutionsToTry = ['1d', '6h', '1h'];

            const isLimitless = name.toLowerCase().includes('limitless');

            // Try each resolution across the top markets before moving to the
            // next resolution.  This avoids the O(markets × resolutions)
            // explosion that caused Probable to time out — for most exchanges
            // the coarsest resolution will succeed on the first active market.
            for (const resolution of resolutionsToTry) {
                if (foundData) break;

                // Cap the number of markets to try per resolution
                const marketsToScan = activeMarkets.slice(0, 15);

                for (const market of marketsToScan) {
                    if (isLimitless) {
                        try {
                            const result = await exchange.fetchOHLCV(market.marketId, {
                                resolution,
                                limit: 10
                            });
                            if (result && result.length > 0) {
                                candles = result;
                                testedOutcomeId = market.marketId;
                                foundData = true;
                                console.info(`[Compliance] ${name}: found ${result.length} candles for market ${market.marketId} at ${resolution}`);
                                break;
                            }
                        } catch (error: any) {
                            lastError = error;
                        }
                        continue;
                    }

                    // Try first outcome per market
                    const outcome = market.outcomes[0];
                    if (!outcome) continue;

                    try {
                        const result = await exchange.fetchOHLCV(outcome.outcomeId, {
                            resolution,
                            limit: 10
                        });
                        if (result && result.length > 0) {
                            candles = result;
                            testedOutcomeId = outcome.outcomeId;
                            foundData = true;
                            console.info(`[Compliance] ${name}: found ${result.length} candles for outcome ${outcome.outcomeId} at ${resolution}`);
                            break;
                        }
                    } catch (error: any) {
                        lastError = error;
                    }
                }
            }

            if (!foundData) {
                // If every attempt hit a server error (5xx), the exchange's
                // OHLCV API is broken — that's not a compliance failure on
                // our side, so skip rather than fail the suite.
                const lastMsg = (lastError?.message || '').toLowerCase();
                if (lastMsg.includes('500') || lastMsg.includes('internal server') || lastMsg.includes('503') || lastMsg.includes('502')) {
                    console.info(`[Compliance] ${name}.fetchOHLCV skipped: exchange API returning server errors (${lastError?.message})`);
                    return;
                }
                throw new Error(
                    `${name}: No OHLCV data found across ${Math.min(activeMarkets.length, 50)} markets ` +
                    `and ${resolutionsToTry.length} resolutions. Last error: ${lastError?.message || 'none'}`
                );
            }

            expect(candles).toBeDefined();
            expect(Array.isArray(candles)).toBe(true);
            expect(candles.length).toBeGreaterThan(0);

            for (const candle of candles) {
                validatePriceCandle(candle, name, testedOutcomeId);
            }

        } catch (error: any) {
            if (isSkippableError(error)) {
                console.info(`[Compliance] ${name}.fetchOHLCV skipped: ${error.message}`);
                return;
            }
            throw error;
        }
    }, 120000);
});
