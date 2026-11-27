"""Fetch a small, verifiable MassBank release sample on the server."""

import hashlib
import base64
import argparse
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.github.com/repos/MassBank/MassBank-data"
RAW = "https://raw.githubusercontent.com/MassBank/MassBank-data"
LIMIT = 30


def metadata(route):
    request = urllib.request.Request(API + route, headers={"User-Agent": "MasspecLib2", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=35) as response:
        payload = response.read(2_000_001)
    if len(payload) > 2_000_000:
        raise ValueError("MassBank metadata exceeds the pilot size limit")
    return json.loads(payload)


def object_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("Invalid Git object ID")
    return value


def tree(sha):
    result = metadata("/git/trees/" + object_id(sha))
    if result["truncated"]:
        raise ValueError("Incomplete MassBank tree")
    return result["tree"]


def main():
    from download import fetch, target_for, atomic, check_space, stamp
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("legacy_downloader", nargs="?", help=argparse.SUPPRESS)
    parser.add_argument("legacy_previous", nargs="?", default="", help=argparse.SUPPRESS)
    parser.add_argument("--previous")
    args = parser.parse_args()
    folder = args.folder
    previous = args.previous if args.previous is not None else args.legacy_previous
    version = metadata("/releases/latest")["tag_name"]
    if not re.fullmatch(r"\d{4}\.\d{2}(?:\.\d+)?", version):
        raise ValueError("Unknown MassBank release tag format")
    release = metadata("/commits/" + version)
    commit = object_id(release["sha"])
    if previous == commit:
        print(json.dumps({"version": version, "commit": commit, "unchanged": True}))
        return
    aafc = next(x for x in tree(release["commit"]["tree"]["sha"]) if x["type"] == "tree" and x["path"] == "AAFC")
    entries = sorted((x for x in tree(aafc["sha"]) if x["type"] == "blob"
                      and re.fullmatch(r"MSBNK-AAFC-[A-Z0-9_]+\.txt", x["path"])), key=lambda x: x["path"])[:LIMIT]
    if not entries:
        raise ValueError("No MassBank pilot records found")
    def download_record(entry):
        name, size, blob = entry["path"], entry["size"], object_id(entry["sha"])
        if not 0 < size <= 1_000_000:
            raise ValueError("MassBank record exceeds the pilot size limit")
        # Content-addressed local paths let unchanged files reuse their verified receipts.
        job = {"id": blob, "source_ids": ["1"], "url": RAW + "/" + commit + "/AAFC/" + name,
               "filename": name, "expected_size": size}
        path = target_for(folder, job)
        if path.is_file():
            raw = path.read_bytes()
        else:
            try:
                fetch(job, folder, reserve_gb=1, retries=1, timeout=10, max_bytes=1_000_000)
                raw = path.read_bytes()
            except (OSError, TimeoutError):
                check_space(folder, 1, size)
                payload = metadata("/git/blobs/" + blob)
                if payload["encoding"] != "base64":
                    raise ValueError("Unexpected Git blob encoding")
                raw = base64.b64decode(payload["content"])
        if len(raw) != size or hashlib.sha1(f"blob {size}\0".encode() + raw).hexdigest() != blob:
            raise ValueError("MassBank Git blob checksum mismatch: " + name)
        sha256 = hashlib.sha256(raw).hexdigest()
        if not path.is_file():
            temp = path.with_suffix(".verified")
            temp.write_bytes(raw)
            temp.replace(path)
            atomic(path.with_name(name + ".receipt.json"), {
                "job_id": blob, "source_ids": ["1"], "url": job["url"], "status": "downloaded",
                "at": stamp(), "bytes": size, "sha256": sha256, "validation": "Git blob ID and SHA256"
            })
        return {"accession": name[:-4], "sha256": sha256, "text": raw.decode("utf-8")}

    with ThreadPoolExecutor(max_workers=4) as executor:
        records = list(executor.map(download_record, entries))
    print(json.dumps({"version": version, "commit": commit, "records": records}))


if __name__ == "__main__":
    main()
