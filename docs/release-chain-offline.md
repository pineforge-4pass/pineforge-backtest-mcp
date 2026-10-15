# Offline MCP release-chain adapter

This implements Brief 6 of the 2026-10-16 release-chain design. Stable hub
releases produce a protected update PR, run this consumer's CI and real stdio
runtime suites, merge on current evidence, and publish through `publish.yml`.
Prereleases use npm `next` and fixed image/GitHub prerelease versions; they do
not activate `latest` or enter the MCP Registry.

## Receiving a ready release

The default-branch `pineforge-release.yml` accepts `repository_dispatch` with
`event_type: pineforge-release` and the exact `pineforge/release-ready/v1` payload
from section 3.2. `scripts/release-contract.mjs` rejects the legacy three-field
payload, extra/missing fields, contradictory types/versions, wrong source
repositories, missing HPO after the cutoff, malformed hashes and circular
manifest identities.

The receiver downloads `release-manifest.json` from the fixed hub repository's
`v<release_version>` release, hashes its original bytes, and compares the
manifest's `release_version`, `prerelease`, `hub_commit`, `versions`, `image` and
`facts` with the dispatch. The design does not define a separate manifest
schema; additional manifest evidence is allowed, and self-identity fields are
forbidden. These artifact fields must retain the same names in the hub lane.
It then verifies hub/component source tags, original facts bytes and their
measured release entry, codegen PyPI/npm package bytes, HPO wheel/sdist bytes
when present, and OCI index/child/config identities and version/source labels.
The package and image data are fetched from their fixed upstream repositories.

A new event creates:

```text
bot/pineforge-release/main/<stable|next>/<version>-<manifest12>
```

The PR changes only `VERSION`, `package.json`, `package-lock.json`, `server.json`,
`release-lock.json` and `release-manifest.json`. The independent package version
uses the existing semver/patch-bump rules. The full event identity appears in a
machine-readable PR marker. The App pushes only this branch. Duplicate desired
or applied events create no new PR or publication. Older events are superseded;
a newer PR closes obsolete bot PRs while preserving their branches and commits.
The same release version with a different manifest is an error.

`release-lock.json` stores the validated dispatch unchanged. Builds generate
`src/release.generated.ts` from it, and npm's runtime defaults to its digest.
`PINEFORGE_IMAGE` remains an explicit user override. The Dockerfile accepts only
the locked `repository@sha256` and checks the supplied version/image arguments
against the copied lock. Its labels identify the tested consumer source and hub
base. Deployment never resolves a newer hub tag.

The initial lock is explicitly `pineforge/offline-bootstrap/v1`, pinned to the
existing 1.5.0 image observed in GHCR on 2026-10-16. The current package remains
0.9.40. This permits building the existing source without fabricating a ready
manifest or facts evidence. Publication rejects this bootstrap schema. The first
newer ready release replaces it through the ordinary update PR.

## Required CI and merge gate

Configure `release/ready` from the `Test` workflow as a required check on `main`,
with strict up-to-date branches. The workflow preserves build/typecheck and all
existing unit tests, packs npm once, installs that tarball, and builds the
self-contained candidate natively on `ubuntu-24.04` and `ubuntu-24.04-arm`.
Both architectures run both delivery entry points against the locked hub image.

Each entry point runs the existing parity, syminfo and negative stdio suites,
plus an identity assertion. The declared top-level test counts are respectively
1, 11, 19 and 1. Parity additionally requires agreement for all 30 seeded probes.
The corpus is pinned to commit `a35c7c4adf7ac3cdf9b0b193e8640510d49cfd3c`, the
original LFS feed is SHA-256 checked, and the vendored resampler derives 15m
bars. The frozen BTC feed must match the committed 2188-bar syminfo hash.
Required negative-case probes must exist and contain source/trades.

The network-fetch negative case uses a local Binance HTTP fixture server serving
the pinned bars. The real transpiler, compiler, engine and grader still execute.
The self-contained image runs its real local entry point through stdio with
matching host/container paths, including the temporary-path refusal cases.
Successful parity calls must report the manifest's actual engine/codegen
versions. npm must choose its digest without `PINEFORGE_IMAGE` being set.

`release/ready` requires the exact test/runtime job inventory and four complete
architecture/entry-point receipts. Failed, cancelled, skipped, missing, empty,
stale-source or different-manifest results fail. The tested tarball integrity,
fixture inventory digest, candidate config IDs and archive hashes are retained.
A CI-only mutation witness restores the former `:latest` default and requires
the actual pin regression to fail with an assertion error; source is restored
in `finally`. Its red TAP and proof are retained with the packed artifact.

`release-pr.yml` runs trusted main code on `workflow_run`, main pushes and a
15-minute reconciliation cadence. It refuses human/unknown commits or changes
outside the allowlist. Before merging it re-verifies the artifacts, latest
successful Test evidence, exact head, current base and newest desired event.
An outdated branch is updated with the App and requires fresh ordinary CI.
It uses the protected merge API with the expected head SHA, never an admin merge.
After merge, it tags the landed release PR commit without rewriting any tag.

## Publishing, receipts and repair

`publish.yml` is still the sole npm/GHCR/GitHub/MCP Registry publisher. It reuses
the complete Test workflow for the landed tag source before any distribution.
It requires an annotated tag matching VERSION and event identity and a merged
release PR. Direct/manual branch publication is rejected.

The publisher saves the previous npm channel and GHCR `latest` digest, requiring
agreement with the prior fixed image version. It publishes the saved tested
architecture images and composes their fixed-version index. It publishes the
exact tested npm tarball under an event-specific candidate tag, verifies npm
integrity, and publishes/verifies the stable MCP Registry entry. Only then can
it move npm `latest`/`next`, stable GHCR `latest`, and GitHub Latest. A final fresh
desired-release check prevents superseded promotion. Fixed versions/assets are
never overwritten or removed.

The npm toolchain is pinned to **11.21.0**, the documented minimum 11.x CLI for
OIDC dist-tag management. Before npm publication, the workflow performs the real
`npm dist-tag add` operation pointing the existing channel at its recorded
current version and reads it back. This proves this workflow's OIDC dist-tag
permission without advancing the channel. A failed proof blocks npm/Registry
publication and channel activation. See [npm's trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).

Artifacts include run attempts. Failed-job reruns select the latest evidence for
each job of the same run and retain earlier history. The channel snapshot records
which exact packed and gated artifacts to reuse; publication does not rebuild.
Re-run failed jobs after a transient publication failure. Do not rerun successful
image-build jobs after publishing fixed versions: a newly built image may differ,
and the fixed-version guard correctly refuses to replace it. A source fix uses a
tested patch release. A fully successful publication is not published again.

Promotion failure/cancellation schedules restoration from the recorded snapshot.
A manual restoration uses `publish.yml`, action `restore`, and the original
`receipt_run_id`. It accepts artifacts only from this repository's publisher,
validates source/run identity, and preflights both current channels before any
write. A newer npm/image publication blocks restoration. The same pinned npm CLI
restores the npm pointer through OIDC, restores GHCR/GitHub Latest when stable,
and verifies the results. No package, tag, release, branch or asset is deleted.
A restoration receipt reports `failed` with recovery `channels_restored`; it does
not claim that the rejected update is deployed.

Consumer transition, gate, OIDC proof, publication, failure and restoration
receipts are Actions artifacts; successful distribution receipts are also
GitHub release assets. Receipts carry neutral role `offline`, event/manifest,
PR/base/head/merge identities, run/attempt, expected inventories, actual source,
package integrity, image digest/configs, consumed facts and previous channel
identities. The terminal `verified` receipt means verified package/image
**distribution**. Users' installations and external hosts such as Glama remain
unverified. A receiver's duplicate/applied acknowledgement only says `merged`;
it does not manufacture deployment evidence.

A collector must require a successful publisher run and a matching terminal
receipt, and give later failure/restoration evidence precedence. A release asset
or an accepted dispatch by itself is not completion evidence. Failed stages
reuse an incident issue per event, mention `RELEASE_CHAIN_OWNER`, and link the
run/PR. Verified completion updates/closes that issue, creating a closed success
issue when no incident existed.

## Supervisor configuration and lane dependencies

| Name / setting | Scope | Purpose |
|---|---|---|
| `PINEFORGE_APP_ID` | Existing repository/organization Actions secret | Existing GitHub App identity; install on this consumer. |
| `PINEFORGE_APP_PRIVATE_KEY` | Existing repository/organization Actions secret | Mint short-lived tokens scoped to this consumer only. |
| App permissions | This repository | Contents write, Pull requests write, Actions read. No required-check/ruleset bypass for consumer merges. |
| `OFFLINE_SYMINFO_FEED_URL` | **New repository Actions variable** | HTTPS location of the frozen BTC 4h feed already described by the committed expected rows. The content must match the committed SHA-256 and 2188 bars; an arbitrary new feed is rejected. |
| `RELEASE_CHAIN_OWNER` | **New repository/organization Actions variable** | GitHub user or team to mention for failure, recovery and success issues. |
| `release/ready` | Main branch protection/ruleset | Required status from Test; require up-to-date branch and squash merging. Remove App bypass. Any retained required review must be satisfied before automation can merge. |
| Actions, Issues, native arm64 runner | Repository settings | Enable workflows/Issues; permit artifact retention, scoped App PRs, package writes and `ubuntu-24.04-arm`. |
| npm trusted publisher | `@pineforge/backtest-mcp`, this repo, **`publish.yml`** | Allow direct `npm publish` **and** explicitly enable **Allow npm dist-tag**. Keep GitHub OIDC; create no npm token. The publish/restore jobs use GitHub-hosted Node 22 runners. |
| GHCR package permissions | Existing consumer image package | Allow this repository's GITHUB_TOKEN to publish; public read access for distributed images. |
| MCP Registry GitHub OIDC | Existing namespace/repository | Preserve existing registry publishing authorization. |

No new secret is required. No Cloudflare/GCP/payment/database configuration is
added. Built-in GITHUB_TOKEN handles issue reporting separately from PR App
credentials. Receivers must land on default `main` before hub dispatch reaches
them. GitHub concurrency can replace a pending run even with cancellation off;
the hub's delivery reconciliation must replay dropped events with the same ID.

Brief 2 must publish the immutable manifest, matching facts/package artifacts and
exact ready event, then collect these neutral receipt artifacts/release assets
with Actions read permission and apply completion/freshness monitoring. Section
3.7 does not define a callback dispatch event name/envelope, so this lane does
not invent one or send the product event back to the hub. Producer readiness
and hub pairing/fan-out remain the producer/hub lanes' responsibility. Live CI
and the exact OIDC proof still need to run after the supervisor configures the
feed variable and pushes this branch.
