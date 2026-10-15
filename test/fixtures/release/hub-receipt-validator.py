#!/usr/bin/env python3
"""CI-only adapter for the hub's unmodified receipt checks.

Vendored because the sibling hub checkout is not present in this repo's CI.
Sources: pineforge-4pass/pineforge-release/scripts/release_receipts.py and
scripts/release_contract.py, Consumer receipt contract v1 (2026-10-16).
Only transport/import plumbing and the fake GitHub API below are local.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import zipfile

COMMIT = r"[0-9a-f]{40}"
SHA = r"[0-9a-f]{64}"
ROLES = ("offline", "hosted", "application", "web", "data", "license")
STATES = ("pending", "pr_open", "testing", "ready", "merged", "deploying", "verified", "failed", "superseded", "skipped_by_policy")
RANK = {state: i for i, state in enumerate(STATES[:7])}
PRODUCT_SCHEMA = "pineforge/consumer-receipt/v1"
FACTS_SCHEMA = "pineforge/facts-consumer-receipt/v1"
COMMON_FIELDS = {"schema", "consumer", "attempt", "sequence", "state", "timestamp",
                 "pr", "ci", "e2e", "deploy", "preview", "deployed", "previous"}


# release_receipts.py SHA-256: 6fe7b0afcb7a34de9e28bce9d8372e5a4eaa6695398536697f59ed705b0cc23a

# release_contract.py SHA-256: a0ba4a20d0ef0a978aa6cd31570c200aa5cca0911499e508179fc3fafeb6f409

class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                       allow_nan=False) + "\n").encode("utf-8")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, "duplicate JSON key")
            out[key] = value
        return out
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: require(False, "nonfinite JSON number"))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Invalid("invalid JSON") from error


def keys(obj, names):
    require(type(obj) is dict and set(obj) == set(names), "unexpected object fields")


def match(pattern, value):
    require(isinstance(value, str) and re.fullmatch(pattern, value) is not None, "malformed identity")
    return value


def positive(value):
    require(type(value) is int and 0 < value <= 2**53 - 1, "expected positive integer")

def object_pages(client, route, key):
    rows = []
    for page in range(1, 1001):
        result = client.api(route + ("&" if "?" in route else "?") + f"per_page=100&page={page}")[key]
        rows.extend(result)
        if len(result) < 100:
            return rows
    raise Invalid("consumer API pagination limit exceeded")


def profile(role):
    profiles = decode(os.environ.get("RELEASE_RECEIPT_POLICY", "{}"))
    require(role in profiles, "consumer evidence policy not configured")
    policy = profiles[role]
    keys(policy, ("workflow", "artifact", "base", "ci", "e2e", "deploy"))
    for item in (policy, policy["ci"], policy["e2e"], policy["deploy"]):
        match(r"[A-Za-z0-9_.-]+\.yml", item["workflow"])
    match(r"[A-Za-z0-9_.-]+", policy["artifact"])
    require(policy["base"] in ("main", "dev"), "unapproved consumer base")
    for name in ("ci", "e2e", "deploy"):
        row = policy[name]
        keys(row, ("workflow", "expected", "approved_skips"))
        require(type(row["expected"]) is list and len(row["expected"]) > 0
                and len(row["expected"]) == len(set(row["expected"])), "empty or duplicate required inventory")
        require(type(row["approved_skips"]) is list and set(row["approved_skips"]) <= set(row["expected"]), "invalid skip policy")
        require(set(row["expected"]) - set(row["approved_skips"]), "entire required inventory cannot be skipped")
    return policy


def check_run(client, repo, evidence, policy, expected_sha):
    keys(evidence, ("run_id", "run_attempt", "sha", "expected", "approved_skips", "results"))
    positive(evidence["run_id"])
    positive(evidence["run_attempt"])
    require(evidence["sha"] == expected_sha, "checks ran against a different source")
    require(evidence["expected"] == policy["expected"] and evidence["approved_skips"] == policy["approved_skips"],
            "required check inventory differs from owner policy")
    run = client.api(f"repos/{repo}/actions/runs/{evidence['run_id']}/attempts/{evidence['run_attempt']}")
    require(run["path"] == ".github/workflows/" + policy["workflow"] and run["head_sha"] == expected_sha,
            "unexpected checks workflow or head")
    require(run["status"] == "completed" and run["conclusion"] == "success", "required check run not successful")
    jobs = object_pages(client, f"repos/{repo}/actions/runs/{evidence['run_id']}/attempts/{evidence['run_attempt']}/jobs", "jobs")
    checked, finished = {}, []
    for name in policy["expected"]:
        found = [row for row in jobs if row["name"] == name]
        require(len(found) == 1 and found[0]["status"] == "completed", "required check missing or incomplete")
        result = found[0]["conclusion"]
        require(result == "success" or (result == "skipped" and name in policy["approved_skips"]), "required check failed/cancelled/skipped")
        if result == "success":
            require(isinstance(found[0].get("completed_at"), str), "required check completion time missing")
            finished.append(found[0]["completed_at"])
        checked[name] = result
    require(evidence["results"] == checked, "reported checks differ from GitHub")
    require(bool(finished), "required inventory contains no successful checks")
    run["checked_finished_at"] = max(finished)
    return run


def identity(obj, *, facts_only=False):
    keys(obj, ("source", "image_digest", "facts_commit", "facts_sha256", "deployment_id_sha256"))
    match(COMMIT, obj["source"])
    match(COMMIT, obj["facts_commit"])
    for name in ("facts_sha256", "deployment_id_sha256"):
        match(SHA, obj[name])
    if not facts_only or obj["image_digest"] is not None:
        match("sha256:" + SHA, obj["image_digest"])


def validate_receipt(client, repo, receipt, event, policy, reporting_run):
    facts_only = receipt.get("schema") == FACTS_SCHEMA
    keys(receipt, COMMON_FIELDS | ({"facts"} if facts_only else {"event_id", "release_version"}))
    require(receipt["schema"] in (PRODUCT_SCHEMA, FACTS_SCHEMA) and receipt["consumer"] in ROLES, "invalid consumer receipt schema")
    if facts_only:
        require(event is None and receipt["consumer"] in ("web", "license"), "unexpected facts-only receipt")
        keys(receipt["facts"], ("commit", "sha256"))
        match(COMMIT, receipt["facts"]["commit"])
        match(SHA, receipt["facts"]["sha256"])
    else:
        require(receipt["event_id"] == event["event_id"] and receipt["release_version"] == event["release_version"], "receipt event differs")
    positive(receipt["attempt"])
    positive(receipt["sequence"])
    require(receipt["state"] in STATES, "invalid receipt state")
    match(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", receipt["timestamp"])
    timestamp = dt.datetime.fromisoformat(receipt["timestamp"].replace("Z", "+00:00"))
    require(timestamp <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5), "receipt timestamp is in future")
    require(reporting_run["path"] == ".github/workflows/" + policy["workflow"], "untrusted receipt workflow")
    require(reporting_run["event"] in ("push", "workflow_dispatch", "workflow_run", "repository_dispatch"),
            "receipt must come from the trusted consumer coordinator")
    # A public receipt never contains private URLs, names, job labels or raw deployment IDs.
    public = {key: receipt[key] for key in ("schema", "consumer", "attempt", "sequence", "state", "timestamp")}
    if facts_only:
        public["facts"] = receipt["facts"]
    else:
        public.update(event_id=receipt["event_id"], release_version=receipt["release_version"])
    public["evidence_sha256"] = sha256(canonical(receipt))
    public["reporting_run_id"] = reporting_run["id"]
    state = receipt["state"]
    if state in ("pending", "failed", "superseded", "skipped_by_policy"):
        require(state != "skipped_by_policy" or (not facts_only and event["prerelease"]), "consumer cannot skip by policy")
        return public
    pr = receipt["pr"]
    keys(pr, ("number", "base", "base_sha", "head", "merge"))
    positive(pr["number"])
    match(COMMIT, pr["base_sha"])
    match(COMMIT, pr["head"])
    require(pr["base"] == policy["base"], "PR base differs from policy")
    actual = client.api(f"repos/{repo}/pulls/{pr['number']}")
    require(actual["base"]["ref"] == pr["base"] and actual["head"]["sha"] == pr["head"], "PR head or base moved")
    require(actual["head"]["repo"]["full_name"].lower() == repo.lower(), "receipt refers to fork PR")
    if not actual["merged"]:
        require(actual["base"]["sha"] == pr["base_sha"], "PR base moved after candidate verification")
    public["pr"] = pr
    if state in ("ready", "merged", "deploying", "verified"):
        ci_run = check_run(client, repo, receipt["ci"], policy["ci"], pr["head"])
        e2e_run = check_run(client, repo, receipt["e2e"], policy["e2e"], pr["head"])
        identity(receipt["preview"], facts_only=facts_only)
        require(receipt["preview"]["source"] == pr["head"]
                and (facts_only or receipt["preview"]["image_digest"] == event["image"]["digest"]),
                "preview did not exercise the candidate source/image")
        for name in ("ci", "e2e"):
            public[name] = {"run_id": receipt[name]["run_id"], "run_attempt": receipt[name]["run_attempt"],
                            "inventory_sha256": sha256(canonical(receipt[name]["results"]))}
        public["preview"] = receipt["preview"]
    if state in ("merged", "deploying", "verified"):
        match(COMMIT, pr["merge"])
        require(actual["merged"] is True and actual["merge_commit_sha"] == pr["merge"], "PR is not the recorded merge")
        # Required E2E must precede the merge; a production smoke cannot stand
        # in for the consumer's candidate E2E gate.
        require(ci_run["checked_finished_at"] <= actual["merged_at"] and e2e_run["checked_finished_at"] <= actual["merged_at"], "CI/E2E completed after merge")
        merged_commit = client.api(f"repos/{repo}/commits/{pr['merge']}")
        require(merged_commit["parents"] and merged_commit["parents"][0]["sha"] == pr["base_sha"],
                "merge inputs differ from the tested base; require updated merge/squash candidate")
    if state == "verified":
        require(reporting_run["head_sha"] == pr["merge"] and reporting_run["event"] != "pull_request", "served receipt source differs")
        deployed_run = check_run(client, repo, receipt["deploy"], policy["deploy"], pr["merge"])
        require(receipt["timestamp"] >= deployed_run["checked_finished_at"], "served receipt predates verification")
        identity(receipt["deployed"], facts_only=facts_only)
        identity(receipt["previous"], facts_only=facts_only)
        require(receipt["deployed"]["source"] == pr["merge"]
                and (facts_only or receipt["deployed"]["image_digest"] == event["image"]["digest"]),
                "actual served source/image differs")
        # A retained newer facts snapshot is allowed only with verified bytes
        # and the same immutable release entry (checked below by the adapter).
        public["deployed"] = receipt["deployed"]
        public["previous"] = receipt["previous"]
        public["deploy"] = {"run_id": receipt["deploy"]["run_id"], "run_attempt": receipt["deploy"]["run_attempt"],
                            "inventory_sha256": sha256(canonical(receipt["deploy"]["results"]))}
    if facts_only:
        for name in ("preview", "deployed"):
            if name in public:
                require(public[name]["facts_commit"] == receipt["facts"]["commit"]
                        and public[name]["facts_sha256"] == receipt["facts"]["sha256"],
                        "facts-only target differs from consumed identity")
    return public


def transition(previous, current):
    if previous is None:
        return True
    old, new = (previous["attempt"], previous["sequence"]), (current["attempt"], current["sequence"])
    if new < old:
        return False
    if new == old:
        require(previous == current, "receipt identity reused with different evidence")
        return False
    if previous["state"] == "verified":
        require(current["state"] == "verified", "verified release cannot regress to a delivery/intermediate state")
    elif previous["attempt"] == current["attempt"] and previous["state"] in ("failed", "superseded", "skipped_by_policy"):
        require(current["state"] == previous["state"], "terminal consumer state requires a new attempt")
    elif previous["attempt"] == current["attempt"] and previous["state"] in RANK and current["state"] in RANK:
        require(RANK[current["state"]] >= RANK[previous["state"]], "consumer state regressed")
    return True


def fetch_artifact(client, repo, run, policy):
    artifacts = object_pages(client, f"repos/{repo}/actions/runs/{run['id']}/artifacts", "artifacts")
    found = [row for row in artifacts if row["name"] == policy["artifact"] and not row["expired"]]
    if not found:
        return None
    require(len(found) == 1, "ambiguous consumer receipt artifact")
    archive = client.request(f"https://api.github.com/repos/{repo}/actions/artifacts/{found[0]['id']}/zip",
                             github=True, accept="application/octet-stream")
    if found[0].get("digest"):
        require(found[0]["digest"] == "sha256:" + sha256(archive), "receipt archive digest differs")
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        require(zipped.namelist() == ["release-receipt.json"], "unexpected receipt archive inventory")
        require(zipped.getinfo("release-receipt.json").file_size <= 2 * 1024 * 1024, "receipt exceeds size limit")
        return decode(zipped.read("release-receipt.json"))



class FixtureClient:
    def __init__(self, data):
        self.data = data
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zipped:
            for name in data.get("archive_names", ["release-receipt.json"]):
                zipped.writestr(name, canonical(data["receipt"]))
        self.archive = archive.getvalue()

    def api(self, route):
        if route == "repos/" + self.data["repo"] + "/actions/runs/90/artifacts?per_page=100&page=1":
            return {"artifacts": [{"name": self.data["policy"]["artifact"], "expired": False,
                                    "id": 99, "digest": "sha256:" + sha256(self.archive)}]}
        return self.data["api"][route]

    def request(self, url, **kwargs):
        require(url.endswith("/actions/artifacts/99/zip"), "unexpected artifact request")
        return self.archive


def main():
    data = decode(sys.stdin.buffer.read())
    client = FixtureClient(data)
    os.environ["RELEASE_RECEIPT_POLICY"] = canonical({"offline": data["policy"]}).decode()
    policy = profile("offline")
    receipt = fetch_artifact(client, data["repo"], data["reporting_run"], policy)
    public = validate_receipt(client, data["repo"], receipt, data["event"], policy, data["reporting_run"])
    if "previous_receipt" in data:
        transition(data["previous_receipt"], public)
    sys.stdout.buffer.write(canonical(public))


if __name__ == "__main__":
    main()
