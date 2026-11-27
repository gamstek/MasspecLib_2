"""Read complete, bounded upstream JSON and retry transient HTTP failures."""
import http.client
import json
import random
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}
NETWORK_ERRORS = (http.client.HTTPException, URLError, TimeoutError, ConnectionError, socket.gaierror)


def rate_limited(error):
    return isinstance(error, HTTPError) and (
        error.code == 429 or
        (error.code == 403 and error.headers and error.headers.get("X-RateLimit-Remaining") == "0")
    )


def is_transient(error):
    if isinstance(error, HTTPError):
        return error.code in TRANSIENT_STATUS
    return isinstance(error, NETWORK_ERRORS)


def failure_kind(error):
    if rate_limited(error):
        return "rate-limit"
    if is_transient(error) or isinstance(error, json.JSONDecodeError):
        return "upstream-unavailable"
    if isinstance(error, HTTPError):
        return "upstream-http"
    if isinstance(error, OSError) and error.errno == 28:
        return "disk-space"
    return "download-failed"


def read_json(request, limit, *, opener=urlopen, wait=time.sleep, on_retry=None):
    for attempt in range(1, 5):
        try:
            with opener(request, timeout=45) as response:
                payload = response.read(limit + 1)
                if len(payload) > limit:
                    raise ValueError("Upstream JSON exceeds size limit")
                advertised = response.headers.get("Content-Length")
                if advertised and advertised.isdigit() and len(payload) != int(advertised):
                    raise http.client.IncompleteRead(payload, max(0, int(advertised) - len(payload)))
            return json.loads(payload)
        except (HTTPError, *NETWORK_ERRORS, json.JSONDecodeError) as error:
            retry_after = error.headers.get("Retry-After", "") if isinstance(error, HTTPError) and error.headers else ""
            explicit_delay = int(retry_after) if retry_after.isdigit() else 0
            temporary = is_transient(error) or isinstance(error, json.JSONDecodeError)
            if not temporary or attempt == 4 or explicit_delay > 20:
                raise
            if on_retry:
                on_retry(attempt + 1)
            wait(max(explicit_delay, 2 ** (attempt - 1) + random.uniform(0, 0.4)))
