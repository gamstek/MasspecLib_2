"""Regression for interrupted MassBank metadata responses without any network access."""
import http.client
import sys
import unittest
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/customer-delivery"))
from source_network import failure_kind, read_json


class Response:
    def __init__(self, payload, length=None):
        self.payload = payload
        self.headers = {"Content-Length": str(length if length is not None else len(payload))}

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return None

    def read(self, size):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload[:size]


class SourceNetworkTest(unittest.TestCase):
    def test_incomplete_chunked_metadata_is_retried(self):
        responses = iter([Response(http.client.IncompleteRead(b'{"tag"', 4), 10),
                          Response(b'{"tag":"2026.11"}')])
        attempts = []
        value = read_json(None, 100, opener=lambda *_a, **_k: next(responses),
                          wait=lambda _: None, on_retry=attempts.append)
        self.assertEqual(value, {"tag": "2026.11"})
        self.assertEqual(attempts, [2])

    def test_short_content_length_stops_after_four_attempts(self):
        calls = []
        def open_response(*_a, **_k):
            calls.append(1)
            return Response(b'{}', 3)
        with self.assertRaises(http.client.IncompleteRead) as result:
            read_json(None, 100, opener=open_response, wait=lambda _: None)
        self.assertEqual(len(calls), 4)
        self.assertEqual(failure_kind(result.exception), "upstream-unavailable")

    def test_http_404_and_long_retry_after_do_not_get_retried(self):
        for status, retry_after, kind in [(404, None, "upstream-http"), (429, "60", "rate-limit")]:
            with self.subTest(status=status):
                headers = Message()
                if retry_after:
                    headers["Retry-After"] = retry_after
                def open_response(*_a, **_k):
                    raise HTTPError("https://example.invalid", status, "failed", headers, None)
                with self.assertRaises(HTTPError) as result:
                    read_json(None, 100, opener=open_response, wait=lambda _: self.fail("unexpected retry"))
                self.assertEqual(failure_kind(result.exception), kind)


if __name__ == "__main__":
    unittest.main()
