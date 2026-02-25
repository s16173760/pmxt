import json
import sys
import types
import unittest

if "pmxt_internal" not in sys.modules:
    fake_pmxt_internal = types.ModuleType("pmxt_internal")

    class _FakeApiClient:
        def __init__(self, configuration=None):
            self.configuration = configuration
            self.default_headers = {}

        def call_api(self, **kwargs):
            return _FakeResponse({"success": True, "data": {}})

    class _FakeConfiguration:
        def __init__(self, host="http://localhost:3847"):
            self.host = host

    class _FakeDefaultApi:
        def __init__(self, api_client=None):
            self.api_client = api_client

    class _FakeApiException(Exception):
        pass

    fake_pmxt_internal.ApiClient = _FakeApiClient
    fake_pmxt_internal.Configuration = _FakeConfiguration
    fake_pmxt_internal.models = types.SimpleNamespace()
    sys.modules["pmxt_internal"] = fake_pmxt_internal

    fake_api_pkg = types.ModuleType("pmxt_internal.api")
    sys.modules["pmxt_internal.api"] = fake_api_pkg

    fake_default_api = types.ModuleType("pmxt_internal.api.default_api")
    fake_default_api.DefaultApi = _FakeDefaultApi
    sys.modules["pmxt_internal.api.default_api"] = fake_default_api

    fake_exceptions = types.ModuleType("pmxt_internal.exceptions")
    fake_exceptions.ApiException = _FakeApiException
    sys.modules["pmxt_internal.exceptions"] = fake_exceptions

from pmxt.client import Exchange


class _FakeResponse:
    def __init__(self, payload):
        self.data = json.dumps(payload).encode("utf-8")

    def read(self):
        return None


class TestRawModeArgs(unittest.TestCase):
    def setUp(self):
        self.exchange = Exchange("polymarket", auto_start_server=False)

    def test_build_request_options_rejects_invalid_mode(self):
        with self.assertRaises(ValueError):
            self.exchange._build_request_options("invalid")

    def test_build_args_preserves_optional_positions_in_raw_mode(self):
        args = self.exchange._build_args_with_optional_options(
            ["outcome-id"],
            [None, 50],
            "raw",
        )
        self.assertEqual(args, ["outcome-id", None, 50, {"mode": "raw"}])

    def test_build_args_trims_trailing_none_without_mode(self):
        args = self.exchange._build_args_with_optional_options(
            ["outcome-id"],
            [10, None],
            None,
        )
        self.assertEqual(args, ["outcome-id", 10])

    def test_call_method_sends_empty_params_when_only_mode_is_set(self):
        captured = {}

        def fake_call_api(**kwargs):
            captured.update(kwargs)
            return _FakeResponse({"success": True, "data": {"ok": True}})

        self.exchange._api_client.call_api = fake_call_api
        result = self.exchange._call_method(
            "fetchMarketsPaginated",
            params=None,
            mode="raw",
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(captured["body"]["args"], [{}, {"mode": "raw"}])


if __name__ == "__main__":
    unittest.main()
