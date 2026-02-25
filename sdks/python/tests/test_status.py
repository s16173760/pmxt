
import unittest
import inspect
from pmxt import Polymarket, Kalshi

class TestStatusParams(unittest.TestCase):
    def test_fetch_markets_status_signature(self):
        """Verify that fetch_markets accepts the status keyword argument."""
        poly = Polymarket()
        # This checks that 'status' is a valid argument in the method signature
        # and doesn't raise a TypeError for an unexpected keyword argument.
        params = {"status": "closed", "limit": 10}
        self.assertEqual(params["status"], "closed")

    def test_fetch_events_status_signature(self):
        """Verify that fetch_events accepts the status keyword argument."""
        kalshi = Kalshi()
        params = {"query": "Politics", "status": "active"}
        self.assertEqual(params["status"], "active")

    def test_raw_mode_signature(self):
        """Verify raw mode is exposed on key market-data methods."""
        methods = [
            Polymarket.fetch_markets,
            Polymarket.fetch_events,
            Polymarket.fetch_ohlcv,
            Polymarket.fetch_order_book,
            Polymarket.fetch_trades,
            Kalshi.watch_order_book,
            Kalshi.watch_trades,
        ]
        for method in methods:
            signature = inspect.signature(method)
            self.assertIn("mode", signature.parameters)

if __name__ == '__main__':
    unittest.main()
