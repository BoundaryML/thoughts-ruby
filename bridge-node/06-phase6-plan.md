# Phase 6 Plan: Release Workflows (sdks/nodejs)

## Overview

Phase 6 ships the Node SDK. By end of phase, a `workflow_dispatch` run of
`/Users/sam/baml3/.github/workflows/release-sdk.yaml` builds NAPI native
prebuilds for every supported `(target, runner)` pair, assembles
per-platform NPM sub-packages plus an umbrella `@boundaryml/baml-core-node`
package, and uploads them all to npmjs.com. A separate dry-run path in
the same workflow runs on every PR that touches `sdks/nodejs/**` so the
publish pipeline is exercised continuously.

> **Canonical package name (locked 2026-05-29):** the published runtime
> npm package is **`@boundaryml/baml-core-node`** — the Node analog of the
> Python `baml_core` wheel (`sdks/python/pyproject.toml:2`). The current
> `bridge_nodejs/package.json` ships `name: "@boundaryml/baml-node"`
> (`package.json:2`); Phase 6.1 **renames it to `@boundaryml/baml-core-node`**.
> Every package-name reference below — the umbrella package, the
> per-platform sub-packages (`@boundaryml/baml-core-node-<triple>`), the
> `napi.binaryName`, the auto-generated `native.js` require strings, the
> `optionalDependencies` map, CI artifact names, and the Verdaccio test —
> derives from this base. Generated `baml_sdk/` packages import runtime
> symbols from `@boundaryml/baml-core-node` (per `00a-spec-codegen-mappings.md`).

Phase 6 is **release plumbing only**. No runtime, codegen, or fixture
code is changed — those are settled by Phases 1–5. The single Rust-side
edit in this phase is wiring `OutputType::NodejsTypescript` into
`baml-cli generate` so end users can actually invoke the emitter that
Phases 2–5 built; without that wiring the published NPM package has no
consumer-facing entry point.

The prior art is the Python release pipeline:
- `/Users/sam/baml3/.github/workflows/release-sdk.yaml` (orchestrator,
  Python wired in today as the only job)
- `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml`
  (8-target matrix, maturin, PyPI artifact pattern `python-sdk-*`)
- `/Users/sam/baml3/baml_language/sdks/python/pyproject.toml` (version
  source-of-truth; bumped in-tree before each release dispatch)

Node mirrors this shape with `napi-rs` standing in for `maturin` and
`npm publish --provenance` standing in for `pypa/gh-action-pypi-publish`.

## Goal (delivery criteria)

1. **`@boundaryml/baml-core-node` is published to NPM** by a single
   `workflow_dispatch` run against `release-sdk.yaml` with `publish_npm:
   true`. The umbrella package's `optionalDependencies` map points at
   per-platform sub-packages (`@boundaryml/baml-core-node-linux-x64-gnu`,
   `@boundaryml/baml-core-node-darwin-arm64`, etc.) which are also published
   in the same run. A fresh `npm install @boundaryml/baml-core-node` on each
   of the six primary target platforms pulls down only the relevant
   native binary and produces a working `require('@boundaryml/baml-core-node')`.
2. **`baml-cli generate` with `output_type "nodejs/typescript"` works
   end to end** on a fixture BAML project. The CLI dispatches to
   `sdkgen_nodejs::to_source_code` (Phases 2–5 deliverable), writes
   the generated `baml_sdk/` tree to disk, and the resulting project
   `npm install`s `@boundaryml/baml-core-node` from the registry and runs.
   (`baml-cli generate` is driven by `generator` blocks / `--from`, not
   a `--language` flag — see `generate.rs:24-33`.)
3. **PR dry-run CI** for every PR that touches `sdks/nodejs/**` runs
   the full build matrix, `napi prepublish --dry-run`, `npm pack`, and
   installs the packed tarballs into a Verdaccio local registry where a
   smoke-test project does `require('@boundaryml/baml-core-node')` and runs
   one BAML function call. Exit non-zero on any failure.
4. **The Node TDD anchor remains green**:
   `cargo nextest run -E 'package(/^sdk_test_nodejs_/)'` passes both
   before and after every Phase 6 sub-phase.
5. **The first real release is documented**: §"Release Runbook"
   contains a step-by-step procedure cut-pasteable by a release manager.

## Current State Analysis

### `/Users/sam/baml3/.github/workflows/release-sdk.yaml` (as of phase entry)

- Trigger: `workflow_dispatch` only with one input, `publish: boolean`
  (default `false`) — `release-sdk.yaml:22-28`.
- Jobs: `build-python-sdk` (reusable, `:41-42`) → `all-builds` (gate,
  `:44-50`) → `publish-to-pypi` (conditional on `inputs.publish`,
  `:52-84`).
- Wheel count guard: `publish-to-pypi` aborts unless ≥8 wheels appear
  in `dist/` (downloaded from artifact pattern `python-sdk-*`) —
  `release-sdk.yaml:66-75`. Node will need its own analogous count
  guard for `.node` artifacts.
- The publish job pulls artifacts directly via
  `actions/download-artifact@v8` (`:61-65`) — note this repo is on the
  **v8** download / **v7** upload action versions (`build-python-sdk.reusable.yaml:114`)
  and `actions/checkout@v6` (`:70`); mirror those exact versions in the
  Node jobs rather than `@v4` (the plan's earlier YAML snippets used
  `@v4` placeholders — bump them).
- Trusted-publishing OIDC binding to PyPI; no token in repo
  (`release-sdk.yaml:76-83`). `permissions.id-token: write` is granted
  at the workflow level (`:34-36`). Node side needs an equivalent (NPM
  trusted publishing; if unavailable for `@boundaryml`, fall back to
  `NPM_TOKEN` repo secret per §Assumptions).
- Two `TODO` comments at the top of the file (`release-sdk.yaml:7-19`)
  note (a) tag-driven trigger not wired yet and (b) Homebrew dispatch
  belongs here. Phase 6 does NOT resolve either TODO — it adds Node as
  a sibling of Python under the same `workflow_dispatch` umbrella.

### `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml`

- 8-target matrix (`build-python-sdk.reusable.yaml:20-56`): `x86_64`/
  `aarch64` × `unknown-linux-gnu`/`unknown-linux-musl` + `x86_64`/
  `aarch64` × `apple-darwin` + `x86_64`/`aarch64` × `pc-windows-msvc`.
  Matrix entries live under a `matrix._.` key (e.g.
  `${{ matrix._.target }}`, `${{ matrix._.runs_on }}`).
- Per-target `manylinux` tag passed to `PyO3/maturin-action`
  (`:104`). Linux glibc → `2_17` (x64) / `2_24` (arm64); musl →
  `musllinux_1_1`.
- ARM64 Windows runs on `windows-11-arm` and bootstraps rustup itself
  (`:58-68`); it sets `matrix._.architecture: arm64` (`:53`).
- Artifact upload: `actions/upload-artifact@v7`, name
  `python-sdk-${{ matrix._.target }}` → path
  `baml_language/sdks/python/dist`, `if-no-files-found: error`
  (`:113-118`). The publish step (in `release-sdk.yaml`) does
  `actions/download-artifact@v8 pattern: python-sdk-*` with
  `merge-multiple: true`.
- The reusable workflow also carries a temporary `push: branches:`
  trigger (`:5-8`, currently `sam/publish-python`, `sam/sdks-rename`)
  alongside `workflow_call: {}`. The Node sibling mirrors this for CI
  rehearsals (see §6.2).

### `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/`

- `package.json:2-18` currently declares `name: "@boundaryml/baml-node"`
  (**must be renamed to `@boundaryml/baml-core-node` in Phase 6.1**),
  `version: "0.0.0-beta"`, `napi.binaryName: "baml_node"`, and an
  8-target `napi.targets` array exactly matching the Python target set.
  - ⚠ **There is NO `optionalDependencies` map and NO `napi.package.name`
    field today.** The plan previously assumed these were pre-wired —
    they are not. `napi prepublish` generates `optionalDependencies`
    from `napi.targets` + `napi.package.name` (defaults to the umbrella
    `name`), so the rename and the `prepublishOnly`/CI `napi prepublish`
    steps are what create the map for the first time.
  - There is no `prepublishOnly` script today; scripts are
    `build:proto`, `build:napi-debug`, `build:napi-release`,
    `build:ts_build`, `build:tag-generated-files`, `build:debug`,
    `build:release`, `test` (`package.json:19-28`). **Note: the local
    build target is `pnpm build:release` (which chains
    `build:napi-release`), not a bare `pnpm build`.**
- `Cargo.toml` builds `cdylib` (lib name `baml_node`) with `napi`
  (`napi5` feature) and `napi-derive`; `build.rs` calls
  `napi_build::setup()`. No additional Rust changes required for
  prebuilds.
  - ⚠ **`binaryName`/lib-name rename:** the napi convention is that
    `binaryName` matches the published base name. The committed
    prebuilt artifact is `baml_node.darwin-arm64.node`, and `native.js`
    hardcodes `./baml_node.<triple>.node` + `@boundaryml/baml-node-<triple>`
    (verified `native.js:83-414`). Renaming the package to
    `@boundaryml/baml-core-node` should also flip `napi.binaryName` to
    `baml_core` and **regenerate `native.js`** (it is auto-generated by
    `@napi-rs/cli` 3.0.4 during `napi build` — `package.json:21-22,30`),
    so the artifacts become `baml_core.<triple>.node` and the require
    strings become `@boundaryml/baml-core-node-<triple>`. The Cargo `[lib]
    name = "baml_node"` can stay (it only names the dylib symbol that
    `napi build` copies into the `.node`); `binaryName` is what drives
    the published filenames. **All `.node` / sub-package filenames in
    this plan use `baml_core.*` accordingly.**
- `native.js` IS present on disk: the auto-generated `requireNative()`
  shim from `@napi-rs/cli`. It tries local `./baml_node.<triple>.node`
  first, then `@boundaryml/baml-node-<triple>`. It must be regenerated
  after the `binaryName` rename (see above) so it resolves
  `baml_core.*` / `@boundaryml/baml-core-node-*`; do not hand-edit it.
- `tsconfig.json` emits `*.js` / `*.d.ts` (+ `.js.map` / `.d.ts.map`)
  next to source. `index.js/.d.ts`, `errors.js/.d.ts`, `proto.js/.d.ts`,
  `ctx_manager.js/.d.ts`, `native.js/.d.ts` all already exist on disk
  (committed because they're consumed by jest integ tests). For
  publish, the `files` array in `package.json` decides which files
  actually ship (and should exclude the `*.map` files and
  `typescript_src/`).
- No `files` array, no `repository`/`license`/`homepage`/`author`
  fields, no README sibling. All must be added before first publish.

### `/Users/sam/baml3/baml_language/sdks/nodejs/sdkgen_nodejs/`

- `Cargo.toml:3` declares `publish = false` (workspace-internal lib;
  shipped inside the `baml-cli` binary, NOT to NPM). This is the
  correct shape — analog of `codegen_python` which also ships inside
  `baml-cli`. **No change.**
- Registered in the workspace at
  `/Users/sam/baml3/baml_language/Cargo.toml:6` (members) and `:58` — but
  under the **old name** `codegen_nodejs` (`{ path = "sdks/nodejs/codegen_nodejs" }`).
  The Phase 2.0 crate rename updates both references to
  `sdkgen_nodejs = { path = "sdks/nodejs/sdkgen_nodejs" }`; after that the
  Phase 6.6 "verify workspace contains sdkgen_nodejs" step is satisfied —
  only `baml_cli/Cargo.toml` needs the dependency added
  (it currently lists `codegen_python` at `:33` but not
  `sdkgen_nodejs`).

### `/Users/sam/baml3/baml_language/crates/baml_cli/src/generate.rs`

- `generate.rs:20` imports `use codegen_python::{NamingConvention,
  OutputType};` — `OutputType`/`NamingConvention` are re-exported from
  `baml_codegen_types` (also re-exported by `sdkgen_nodejs`, see its
  `lib.rs`). `discover_generators` parses `output_type` via strum's
  `FromStr` on `OutputType` (`generate.rs:227-235`).
- Only `OutputType::PythonPydantic` and `OutputType::PythonPydanticV1`
  exist today. The dispatch `match` at `generate.rs:148-156` covers
  only those two variants (both arms call `codegen_python::to_source_code`).
- The expected-values help strings are hardcoded as
  `r#"one of: "python/pydantic", "python/pydantic/v1""#`
  (`generate.rs:231`) and the "no generator blocks found" example
  prints `output_type python/pydantic` (`generate.rs:116-129`). Both
  must be extended to mention `"nodejs/typescript"`.
- `sdkgen_nodejs::to_source_code(_pool, _user_baml_files,
  _naming_convention)` already exists as a 3-arg stub that
  `unimplemented!()`s (`sdkgen_nodejs/src/lib.rs:18-26`); its
  signature matches `codegen_python::to_source_code`. Phase 6.6 just
  wires the new variant + match arm.
- ⚠ The output directory is hardcoded to `<output_dir>/baml_sdk`
  (`generate.rs:252`) for ALL generators, so the Node generator also
  emits into `baml_sdk/` — consistent with the spec's `baml_sdk`
  package name. No per-language branching of the output path needed.

### `/Users/sam/baml3/cliff.toml`

- No SDK-specific scopes today. No change required for Phase 6 — Node
  release notes are generated by `git-cliff` from conventional commits
  the same way Python's are.

### `/Users/sam/baml3/LICENSE`

- Repo-root Apache-2.0. The published NPM tarballs will include a
  `LICENSE` copy beside `package.json`; Phase 6 adds a `LICENSE`
  symlink (or a build-time copy step) in each NPM tarball.

## What We're NOT Doing

- **No code changes inside `bridge_nodejs`, `sdkgen_nodejs`, or
  `typescript_src`.** All runtime and codegen behavior was settled in
  Phases 1–5. If a bug surfaces during Phase 6 smoke tests, it gets
  fixed in a Phase-5 follow-up commit, not as part of the release
  workflow.
- **No new fixtures, no new `sdk_test_nodejs_*` crates.** The Phase 5
  TDD anchor stays as-is.
- **No tag-driven trigger.** The two `TODO`s at the top of
  `release-sdk.yaml` explicitly defer this. Phase 6 stays on
  `workflow_dispatch`, matching Python's current state.
- **No Homebrew dispatch.** Also explicitly deferred per the same
  TODOs.
- **No tag-based version stamping inside Rust.** The version in
  `bridge_nodejs/package.json` is the source of truth (mirrors how
  `pyproject.toml` is the Python source of truth) and is bumped
  manually in-tree before each release dispatch.
- **No CHANGELOG separate from the repo root.** `git-cliff` handles
  release notes globally; no Node-specific changelog file.

## Implementation Approach

### Versioning policy (Assumption)

`@boundaryml/baml-core-node` tracks the BAML CLI version in lockstep, same
as Python's `baml_core` wheel (`pyproject.toml:3` is at `0.1.3`
today). The version field in
`/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json`
(currently `"0.0.0-beta"`) is bumped by the same human who bumps
`/Users/sam/baml3/baml_language/sdks/python/pyproject.toml` ahead of a
release dispatch. The per-platform sub-packages
(`@boundaryml/baml-core-node-<triple>`) inherit the same version via
`napi prepublish`'s `--update-version` behavior.

### Target matrix (Assumption)

Phase 6 ships the same 8 targets the Python pipeline ships. Rationale:
the dev team already validates and tests on these targets for Python,
so the runner availability and CI maintenance is already paid for. The
napi-rs CLI's `prepublish` step expects target triples in the same
form (`x86_64-unknown-linux-gnu` etc.), so the matrix maps 1:1.

See §NAPI Target Matrix for the full table.

### Authentication (Assumption)

Use **NPM trusted publishing** (OIDC), parallel to the PyPI OIDC
trusted-publisher binding that the Python pipeline uses. The
`@boundaryml/baml-core-node` package on npmjs.com is configured with this
repo + workflow file as the trusted publisher. **Fallback:** if
trusted publishing is unavailable for `@boundaryml`, use a fine-scoped
`NPM_TOKEN` org secret. The plan documents both paths so the runbook
can pick whichever works on first execution.

### Per-platform package naming

Standard napi-rs scheme: `@boundaryml/baml-core-node-<platform>-<arch>-<libc>`.
Examples: `@boundaryml/baml-core-node-linux-x64-gnu`,
`@boundaryml/baml-core-node-darwin-arm64`. The umbrella package lists each
as an `optionalDependencies` entry pinned to the exact same version,
and the auto-generated `native.js` at runtime walks the
`process.platform`/`process.arch`/musl-detection tree to require the
right one. ⚠ The `optionalDependencies` map does **not** exist in
`package.json` yet — `napi prepublish` (run via the `prepublishOnly`
script locally and in the `publish-to-npm` CI job) generates it from
`napi.targets` + `napi.package.name`. The `native.js` dispatch shim is
already emitted by `@napi-rs/cli`, but only resolves the correct
`@boundaryml/baml-core-node-*` names once it is regenerated against the new
`binaryName` (Phase 6.1).

### Sub-phase ordering

8 sub-phases. Each is independently committable, each leaves the tree
in a green state for both `cargo nextest -E
'package(/^sdk_test_nodejs_/)'` AND `npm install / pnpm test` inside
`bridge_nodejs/`. Sub-phases 6.1–6.4 can be done locally; 6.5–6.8 are
CI-only and verified by `workflow_dispatch` rehearsals (with
`publish_npm: false`).

---

## Phase 6.1: `package.json` rename + finalization + napi target sanity

### Goal

Rename the package to `@boundaryml/baml-core-node`, add the publish-required
`package.json` fields, and confirm `napi build` works locally for the
host triple.

### Files

- `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json`
  — **rename + edit:**
  - **Rename `"name": "@boundaryml/baml-node"` →
    `"name": "@boundaryml/baml-core-node"`** (`package.json:2`). This is the
    load-bearing change of the sub-phase — every per-platform
    sub-package and the `optionalDependencies` map derive from it.
  - **Change `napi.binaryName: "baml_node"` → `"baml_core"`**
    (`package.json:7`) so prebuild filenames become
    `baml_core.<triple>.node` and the auto-generated `native.js`
    resolves `@boundaryml/baml-core-node-<triple>`.
  - Optionally set `napi.package.name` explicitly to
    `"@boundaryml/baml-core-node"` so `napi prepublish`'s sub-package naming
    is unambiguous (defaults to the umbrella `name` otherwise).
  - **Regenerate `native.js` / `native.d.ts`** by running
    `pnpm build:napi-release` (or `build:napi-debug`) after the
    `binaryName` change — do not hand-edit; the file is
    `@napi-rs/cli`-generated and currently hardcodes the old
    `baml_node` / `baml-node` strings.
  - add:
  - `"description": "Node.js bindings for the BAML runtime (powered
    by bex_engine)."`
  - `"license": "Apache-2.0"`
  - `"homepage": "https://docs.boundaryml.com"`
  - `"repository": { "type": "git", "url":
    "https://github.com/BoundaryML/baml" }`
  - `"author": { "name": "Boundary", "email": "contact@boundaryml.com" }`
  - `"keywords": ["baml", "boundaryml", "boundary", "llm", "ai"]`
  - `"engines": { "node": ">=18" }` (NAPI v5 minimum; pick 18 LTS as
    the floor since napi-rs 3.x dropped 16)
  - `"files": [ "index.js", "index.d.ts", "errors.js", "errors.d.ts",
    "proto.js", "proto.d.ts", "ctx_manager.js", "ctx_manager.d.ts",
    "native.js", "native.d.ts", "README.md", "LICENSE" ]` (everything
    consumed at runtime, NOT typescript sources or test files)
  - `"publishConfig": { "access": "public", "provenance": true }`
- `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json`
  — also add a new script:
  - `"prepublishOnly": "napi prepublish -t npm --skip-gh-release"` —
    populates `npm/<triple>/package.json` for each entry in
    `napi.targets` and updates the umbrella `optionalDependencies`
    map. This is the standard napi-rs publish-time step.

### Local verification

```
cd /Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs
pnpm install
pnpm build:release    # produces baml_core.<host-triple>.node + regenerates native.js
pnpm test             # jest suite still green (imports unaffected; package name is internal)
npm pack --dry-run    # lists exactly the files in "files" + package.json; name is @boundaryml/baml-core-node
grep -q 'baml-core' native.js   # sanity: regenerated require strings use the new scope
```

### Commit

`chore(nodejs-sdk): rename to @boundaryml/baml-core-node + finalize package.json`

---

## Phase 6.2: Per-platform NAPI prebuild matrix (CI scaffolding)

### Goal

Add a new reusable workflow that builds `.node` artifacts for each
target in §NAPI Target Matrix. Mirrors
`build-python-sdk.reusable.yaml`.

### Files

- New: `/Users/sam/baml3/.github/workflows/build-nodejs-sdk.reusable.yaml`
  — strategy/matrix structure 1:1 with
  `build-python-sdk.reusable.yaml` (same `matrix._.` key shape,
  `fail-fast: false`, `windows-11-arm` for arm64 Windows with the
  verbatim rustup bootstrap from `:58-68`). Key differences:
  - Use `actions/checkout@v6`, `actions/upload-artifact@v7`,
    `actions/download-artifact@v8` to match the versions already pinned
    in this repo (NOT `@v4`).
  - Replace `actions/setup-python` with `actions/setup-node`
    (Node 20 LTS) + `pnpm/action-setup` (pnpm 9; the repo's
    `bridge_nodejs` lockfile is `pnpm-lock.yaml`).
  - Replace `PyO3/maturin-action@v1` with a two-step block:
    1. `uses: dtolnay/rust-toolchain@stable` with `targets:
       ${{ matrix._.target }}`.
    2. Linux cross builds use `napi-rs/setup-zig@v1` or
       `napi-rs/action`'s `setup-cross-toolchain`. Mirror napi-rs's
       own release workflow patterns
       (https://github.com/napi-rs/package-template).
    3. `pnpm install --frozen-lockfile`.
    4. `pnpm exec napi build --platform --release --target
       ${{ matrix._.target }}` (working-directory:
       `baml_language/sdks/nodejs/bridge_nodejs`).
    5. `pnpm build:proto && pnpm build:ts_build && pnpm
       build:tag-generated-files` — same TypeScript bits the local
       `build:release` script does, so the artifact contains
       everything `files` claims it does.
  - musl targets: use `messense/rust-musl-cross:<arch>-musl` Docker
    image as the build environment (napi-rs documents this in their
    cross-build guide).
  - ARM64 macOS / x64 macOS: use `macos-latest` (Apple Silicon
    runner; cross-compiles x86_64 via `-target x86_64-apple-darwin`).
    Mirror the Python pipeline which uses the same runner for both.
  - ARM64 Windows: use `windows-11-arm` runner exactly like the
    Python pipeline. Rustup bootstrap step mirrored verbatim.
  - Artifact name pattern: `nodejs-sdk-${{ matrix._.target }}` →
    contents are the contents of
    `baml_language/sdks/nodejs/bridge_nodejs/npm/<short-triple>/`
    (created by `napi prepublish` later — for this sub-phase we just
    upload the raw `baml_core.<triple>.node` plus the per-platform
    `package.json` that `napi prepublish` will emit). Set
    `if-no-files-found: error` like the Python upload (`:118`).

### Local verification (CI rehearsal)

Add a temporary `workflow_dispatch` trigger to
`build-nodejs-sdk.reusable.yaml` (mirroring the existing `push:
branches:` block in `build-python-sdk.reusable.yaml`). Run it once,
inspect that all 8 matrix legs go green and that the upload artifact
contains exactly one `.node` file per leg.

Once green, remove the temporary trigger (the file becomes
`workflow_call:` only, like the Python sibling).

### Commit

`ci(nodejs-sdk): add NAPI prebuild matrix workflow`

---

## Phase 6.3: `npm pack` smoke test

### Goal

Before any publish wiring, prove that `npm pack` produces a sane
tarball. This is the inner-loop test that the `files` array and
`prepublishOnly` script work correctly.

### Files

- Add a step to `build-nodejs-sdk.reusable.yaml` (after the upload-
  artifact step) that runs only on the **host build leg**
  (e.g., `x86_64-unknown-linux-gnu`):
  ```yaml
  - name: Pack tarball smoke test
    if: matrix._.target == 'x86_64-unknown-linux-gnu'
    working-directory: baml_language/sdks/nodejs/bridge_nodejs
    run: |
      pnpm exec napi prepublish -t npm --skip-gh-release --dry-run
      npm pack
      ls -la *.tgz
      tar -tzf *.tgz | sort > /tmp/tarball-contents.txt
      cat /tmp/tarball-contents.txt
      # Expected files (one entry per line):
      grep -q 'package/index.js'   /tmp/tarball-contents.txt
      grep -q 'package/index.d.ts' /tmp/tarball-contents.txt
      grep -q 'package/native.js'  /tmp/tarball-contents.txt
      grep -q 'package/README.md'  /tmp/tarball-contents.txt
      grep -q 'package/LICENSE'    /tmp/tarball-contents.txt
      # No source files leaked:
      ! grep -q 'package/typescript_src/' /tmp/tarball-contents.txt
      ! grep -q 'package/src/'            /tmp/tarball-contents.txt
      ! grep -q 'package/tests/'          /tmp/tarball-contents.txt
  ```

### Verification

Run the workflow with `workflow_dispatch`. The `Pack tarball smoke
test` step's `grep -q` assertions either all pass (green) or surface
exactly which file is missing/leaked.

### Commit

`ci(nodejs-sdk): assert npm pack tarball contents`

---

## Phase 6.4: Verdaccio local-registry install smoke test

### Goal

Prove that an installer-facing consumer can `npm install
@boundaryml/baml-core-node@<version>` from a registry and that
`require('@boundaryml/baml-core-node')` returns a working native binding.

### Files

- Add a new job to `build-nodejs-sdk.reusable.yaml`, gated by `needs:
  build` (the matrix job), that:
  1. Spins up a Verdaccio container (`docker run -d -p 4873:4873
     verdaccio/verdaccio:5`).
  2. Downloads the umbrella tarball + all per-platform tarballs from
     the matrix artifacts (`actions/download-artifact@v8` pattern
     `nodejs-sdk-*`).
  3. `npm publish --registry http://localhost:4873 --userconfig
     /tmp/npmrc` for each tarball (with a dummy auth-token bootstrap).
  4. Creates a fresh temp dir, `npm init -y`, `npm install
     --registry http://localhost:4873 @boundaryml/baml-core-node`.
  5. Runs an inline smoke script:
     ```js
     const baml = require('@boundaryml/baml-core-node');
     console.log(baml.getVersion());
     console.log(Object.keys(baml));
     // Assert the expected exports exist. Keep this list in sync with
     // bridge_nodejs/index.d.ts (current surface: BamlRuntime,
     // AbortController, BamlHandle, HostSpanManager, getVersion,
     // flushEvents from ./native; Collector, FunctionLog, FunctionResult,
     // callFunctionSync, callFunction; CtxManager; the BamlError family).
     const expected = ['BamlRuntime', 'AbortController', 'BamlHandle',
                       'HostSpanManager', 'getVersion', 'flushEvents',
                       'Collector', 'FunctionLog', 'callFunction',
                       'callFunctionSync', 'CtxManager'];
     for (const k of expected) {
       if (!(k in baml)) {
         console.error('Missing export:', k);
         process.exit(1);
       }
     }
     ```

### Verification

`workflow_dispatch` rehearsal. The `Verdaccio install smoke` job
fails-loud if any of the per-platform sub-packages are mis-tagged,
the umbrella `optionalDependencies` map is broken, or the
`getVersion()` native call segfaults.

### Commit

`ci(nodejs-sdk): verdaccio install + require() smoke test`

---

## Phase 6.5: Wire into `release-sdk.yaml`

### Goal

Hook the new reusable workflow into the existing release orchestrator,
plus add an `npm publish` job parallel to `publish-to-pypi`.

### Files

- Edit
  `/Users/sam/baml3/.github/workflows/release-sdk.yaml`:
  - Add input `publish_npm: boolean` (default `false`) alongside the
    existing `publish` input. Rename the existing `publish` input to
    `publish_pypi: boolean` (default `false`) for symmetry. Document
    both at the top of the file. **Backwards compatibility note:**
    this is a renamed `workflow_dispatch` input; nobody outside this
    repo can call the workflow with the old name, so the rename is
    safe.
  - Add new job `build-nodejs-sdk:` that
    `uses: ./.github/workflows/build-nodejs-sdk.reusable.yaml`.
  - Extend `all-builds.needs` to include `build-nodejs-sdk`.
  - Add new job `publish-to-npm:` mirroring `publish-to-pypi`:
    ```yaml
    publish-to-npm:
      needs: [all-builds]
      if: ${{ inputs.publish_npm }}
      runs-on: ubuntu-latest
      permissions:
        id-token: write   # for NPM trusted publishing
        contents: read
      steps:
        - uses: actions/checkout@v6
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            registry-url: https://registry.npmjs.org
        - uses: pnpm/action-setup@v4
          with: { version: 9 }
        - uses: actions/download-artifact@v8
          with:
            pattern: nodejs-sdk-*
            path: baml_language/sdks/nodejs/bridge_nodejs/artifacts
            merge-multiple: false
        - name: Stage per-platform packages
          working-directory: baml_language/sdks/nodejs/bridge_nodejs
          run: |
            set -euo pipefail
            pnpm install --frozen-lockfile
            # napi prepublish reads ./artifacts/, places .node binaries
            # into ./npm/<triple>/, and produces per-platform
            # package.json files inheriting the umbrella version.
            pnpm exec napi prepublish -t npm --skip-gh-release
        - name: Verify artifact count
          working-directory: baml_language/sdks/nodejs/bridge_nodejs
          run: |
            set -euo pipefail
            count=$(ls npm/*/baml_core.*.node 2>/dev/null | wc -l)
            if [ "$count" -lt 8 ]; then
              echo "::error::Expected at least 8 .node artifacts, found $count"
              exit 1
            fi
        - name: Publish per-platform sub-packages
          working-directory: baml_language/sdks/nodejs/bridge_nodejs
          env:
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
            # Trusted publishing (OIDC) is preferred; NODE_AUTH_TOKEN
            # is the fallback. Both work with `npm publish` when
            # `--provenance` is set and `id-token: write` is granted.
          run: |
            for dir in npm/*/; do
              echo "Publishing $dir"
              ( cd "$dir" && npm publish --access public --provenance )
            done
        - name: Publish umbrella package
          working-directory: baml_language/sdks/nodejs/bridge_nodejs
          env:
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          run: |
            npm publish --access public --provenance
    ```

### Verification

Run the workflow with `publish_pypi: false, publish_npm: false` (full
rehearsal — builds everything, asserts everything, skips both
publishes). Expected: green. Then on the real release day, the runbook
flips the booleans (see §Release Runbook).

### Commit

`ci(release-sdk): wire NAPI build + NPM publish into release-sdk.yaml`

---

## Phase 6.6: `baml-cli generate` + `output_type "nodejs/typescript"` integration

### Goal

Make `sdkgen_nodejs::to_source_code` reachable from the CLI so end
users can actually generate a `baml_sdk/` directory. Without this
wiring the published NPM package has no entry point users can hit.

### Files

- Edit
  `/Users/sam/baml3/baml_language/crates/baml_codegen_types/src/generator_fields.rs`:
  ```rust
  #[strum(serialize = "nodejs/typescript")]
  NodejsTypescript,
  ```
  (Added as a new variant on `OutputType`. The `Display` / `EnumString`
  derive picks it up automatically. Both `codegen_python` and
  `sdkgen_nodejs` re-export this enum, so the new variant is visible
  through the existing `use codegen_python::{..., OutputType}` import.)
- Edit
  `/Users/sam/baml3/baml_language/crates/baml_cli/src/generate.rs`:
  - Add a `use sdkgen_nodejs;` (or reference `sdkgen_nodejs::` fully
    qualified) alongside the existing `use codegen_python::{...}` at
    `generate.rs:20`.
  - Extend the `match generator.output_type` block at
    `generate.rs:148-156`:
    ```rust
    OutputType::NodejsTypescript => sdkgen_nodejs::to_source_code(
        &pool,
        &user_baml_files,
        generator.naming_convention,
    ),
    ```
  - Update the "no generator blocks found" help example at
    `generate.rs:116-129` (the `eprintln!` block) and the
    expected-values string at `generate.rs:231`
    (`r#"one of: "python/pydantic", "python/pydantic/v1""#`) to also
    mention `"nodejs/typescript"`.
- Edit
  `/Users/sam/baml3/baml_language/crates/baml_cli/Cargo.toml`:
  - Add `sdkgen_nodejs = { workspace = true }` to `[dependencies]`
    (currently only `codegen_python` is listed, `Cargo.toml:33`).
- `/Users/sam/baml3/baml_language/Cargo.toml` workspace already
  declares `sdkgen_nodejs = { path = "sdks/nodejs/sdkgen_nodejs" }`
  (`:58`) and lists it as a member (`:6`) — **no change needed there.**

### Local verification

```
cd /Users/sam/baml3
cargo build -p baml_cli
# Pick an existing sdk_test_nodejs fixture's baml_src/, add a
# generator block:
#   generator nodejs {
#     output_type "nodejs/typescript"
#     naming_convention "preserve-case"
#     output_dir ".."
#   }
# Then:
./target/debug/baml-cli generate --from <fixture>/baml_src
# Inspect generated baml_sdk/ matches what sdkgen_nodejs emits.
```

### Commit

`feat(baml-cli): wire output_type "nodejs/typescript" into generate`

---

## Phase 6.7: README + LICENSE + npmjs.com presentation

### Goal

The package page on npmjs.com must look professional. README must
explain installation and link to the docs site. LICENSE must be
included in the published tarball.

### Files

- New: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/README.md`
  — mirror the shape of
  `/Users/sam/baml3/baml_language/sdks/python/README.md` (exists, 754
  bytes). Contents:
  ```markdown
  # @boundaryml/baml-core-node

  Node.js / TypeScript bindings for the BAML runtime (powered by
  `bex_engine`).

  `@boundaryml/baml-core-node` is the bridge layer that generated
  `baml_sdk/` packages import at runtime: it provides the
  `BamlRuntime` singleton, the protobuf encoder/decoder, the
  function/method factories, and the `Collector` / `CtxManager`
  observability primitives.

  ```ts
  import { BamlRuntime } from '@boundaryml/baml-core-node';

  const rt = BamlRuntime.initializeRuntime({
    rootPath: '.',
    files: { 'main.baml': bamlSource },
    sdkRoot: 'my_sdk',
  });
  ```

  This package is generally consumed indirectly via the code
  generated by `baml-cli generate --output_type nodejs/typescript` —
  direct use is reserved for runtime authors and bridge tests.

  See the full docs at https://docs.boundaryml.com.

  ## Requirements

  - Node.js 18+
  - One of the supported platforms: linux x64/arm64 (glibc + musl),
    macOS x64/arm64, Windows x64/arm64.

  ## License

  Apache-2.0 — see `LICENSE`.
  ```
- New: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/LICENSE`
  — copy of `/Users/sam/baml3/LICENSE` (repo-root Apache-2.0, 201
  lines). The
  cleanest cross-platform option is a real-file copy committed
  alongside (symlinks break on Windows checkouts unless
  `core.symlinks=true`); pick the **copy** option to stay safe.
- Update
  `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json`'s
  `files` array (Phase 6.1 already added `README.md` and `LICENSE` —
  this sub-phase ensures both files actually exist on disk).
- Per-platform sub-packages also need a LICENSE. `napi prepublish`
  copies the umbrella `LICENSE` to each `npm/<triple>/` dir
  automatically (per napi-rs docs); confirm in the §6.4 Verdaccio
  smoke test by `ls npm/*/LICENSE`.

### Local verification

```
cd /Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs
npm pack --dry-run | grep -E '(README|LICENSE)'
# Expected:
#   npm notice 1.2kB README.md
#   npm notice 11.4kB LICENSE
```

### Commit

`docs(nodejs-sdk): add README and LICENSE for NPM tarball`

---

## Phase 6.8: First real release (manual)

### Goal

Cut `@boundaryml/baml-core-node@<X.Y.Z>` on npmjs.com. This sub-phase is
**not a code change** — it's the documented runbook executed once. The
plan's deliverable here is the runbook below (§Release Runbook), not a
commit.

After execution, this sub-phase is "done" the moment `npm view
@boundaryml/baml-core-node version` returns the expected version and a
fresh `npm install @boundaryml/baml-core-node` in a scratch project works
on at least three platforms (macOS arm64, Linux x64 gnu, Linux x64
musl). A short release-notes paragraph is added to a GitHub release
entry under the same tag-or-dispatch the Python pipeline uses.

---

## Release Runbook

A release manager executing the **first** real Node SDK release runs
these steps in order. Subsequent releases follow the same steps minus
the one-time setup at the top.

### One-time setup (first release only)

1. **Reserve the package name on NPM.** Log into
   https://www.npmjs.com as the `@boundaryml` org owner. Visit
   "Add package" and create `@boundaryml/baml-core-node` as a placeholder
   (publish a 0.0.0-reserved tarball with just a README). This
   prevents name-squatting.
2. **Configure NPM trusted publishing.** On the package settings
   page → "Trusted Publisher", add a GitHub Actions trusted
   publisher:
   - Repository: `BoundaryML/baml`
   - Workflow filename: `release-sdk.yaml`
   - Environment: (leave blank unless added later)
3. **Pre-create the per-platform sub-packages** so the first
   publish doesn't get rejected for "package does not exist":
   - For each triple in §NAPI Target Matrix, publish an empty 0.0.0
     stub from a local checkout with `npm publish --dry-run` first to
     verify naming, then a real `npm publish` to reserve the name.
   - Optional but recommended; napi-rs's CI can create them on first
     publish if the NPM token has create-package permissions.
4. **Set `NPM_TOKEN` secret** (only if trusted publishing isn't
   used). Go to GitHub → Settings → Secrets and Variables → Actions,
   add `NPM_TOKEN` with a fine-scoped token granting `publish` on
   `@boundaryml/baml-core-node*`.

### Per-release steps

1. **Bump version in-tree.** Edit
   `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json`,
   change `"version": "0.0.0-beta"` to the target version (e.g.,
   `"0.1.0"`). Commit + PR + merge.
2. **(Lockstep) Bump Python version** in
   `/Users/sam/baml3/baml_language/sdks/python/pyproject.toml` to the
   same value if shipping both. Same PR or sibling PR.
3. **Rehearse the publish.** Trigger `release-sdk.yaml` via
   `workflow_dispatch` with `publish_pypi: false, publish_npm:
   false`. Wait for green. Inspect the `Verify artifact count` step
   in `publish-to-npm` log (it won't actually run with `publish_npm:
   false`, but the build matrix output reveals any per-target
   regressions).
4. **Execute the publish.** Re-trigger `release-sdk.yaml` with
   `publish_pypi: true, publish_npm: true`. Watch `publish-to-npm`:
   - "Stage per-platform packages" — `napi prepublish` populates
     `npm/<triple>/`.
   - "Verify artifact count" — must be ≥8.
   - "Publish per-platform sub-packages" — one `npm publish` per
     triple. If a single triple fails, the loop aborts; subsequent
     re-runs will re-publish already-published triples and fail with
     "cannot publish over previously published version". Resolution:
     bump version, re-run. **Never use `--force`.**
   - "Publish umbrella package" — the final step.
5. **Smoke test in three environments:**
   ```
   # macOS arm64
   mkdir /tmp/smoke && cd /tmp/smoke && npm init -y \
     && npm install @boundaryml/baml-core-node \
     && node -e "console.log(require('@boundaryml/baml-core-node').getVersion())"

   # Linux x64 gnu (Docker)
   docker run --rm -it node:20 sh -c \
     "mkdir /smoke && cd /smoke && npm init -y \
      && npm install @boundaryml/baml-core-node \
      && node -e \"console.log(require('@boundaryml/baml-core-node').getVersion())\""

   # Linux x64 musl (Docker)
   docker run --rm -it node:20-alpine sh -c \
     "apk add --no-cache libc6-compat && mkdir /smoke && cd /smoke \
      && npm init -y && npm install @boundaryml/baml-core-node \
      && node -e \"console.log(require('@boundaryml/baml-core-node').getVersion())\""
   ```
6. **Tag + GitHub Release.** Create a `v<X.Y.Z>` git tag pointing at
   the merged version-bump commit. Use GitHub UI → Releases →
   "Generate release notes" (powered by `git-cliff` config at
   `/Users/sam/baml3/cliff.toml`). Publish.
7. **Announce.** Update the docs site to bump the
   `@boundaryml/baml-core-node@<version>` mention; tweet/Slack/etc.

### Rollback

If a published version is broken: **do not unpublish** (npm's 72-hour
unpublish rule + downstream consumers). Instead, publish a
deprecation notice:
```
npm deprecate @boundaryml/baml-core-node@<X.Y.Z> "Broken release — use <X.Y.Z+1>"
```
…then bump the version and re-release per the per-release steps.

---

## NAPI Target Matrix

This is the canonical list; `package.json`'s `napi.targets` array,
`build-nodejs-sdk.reusable.yaml`'s matrix, and the umbrella
`optionalDependencies` map all derive from this table.

| Target triple                      | CI runner          | napi short name        | NPM sub-package                                  | Artifact name                       |
|------------------------------------|--------------------|------------------------|--------------------------------------------------|-------------------------------------|
| `x86_64-unknown-linux-gnu`         | `ubuntu-latest`    | `linux-x64-gnu`        | `@boundaryml/baml-core-node-linux-x64-gnu`            | `nodejs-sdk-x86_64-unknown-linux-gnu` |
| `aarch64-unknown-linux-gnu`        | `ubuntu-latest`    | `linux-arm64-gnu`      | `@boundaryml/baml-core-node-linux-arm64-gnu`          | `nodejs-sdk-aarch64-unknown-linux-gnu` |
| `x86_64-unknown-linux-musl`        | `ubuntu-latest`    | `linux-x64-musl`       | `@boundaryml/baml-core-node-linux-x64-musl`           | `nodejs-sdk-x86_64-unknown-linux-musl` |
| `aarch64-unknown-linux-musl`       | `ubuntu-latest`    | `linux-arm64-musl`     | `@boundaryml/baml-core-node-linux-arm64-musl`         | `nodejs-sdk-aarch64-unknown-linux-musl` |
| `x86_64-apple-darwin`              | `macos-latest`     | `darwin-x64`           | `@boundaryml/baml-core-node-darwin-x64`               | `nodejs-sdk-x86_64-apple-darwin`    |
| `aarch64-apple-darwin`             | `macos-latest`     | `darwin-arm64`         | `@boundaryml/baml-core-node-darwin-arm64`             | `nodejs-sdk-aarch64-apple-darwin`   |
| `x86_64-pc-windows-msvc`           | `windows-latest`   | `win32-x64-msvc`       | `@boundaryml/baml-core-node-win32-x64-msvc`           | `nodejs-sdk-x86_64-pc-windows-msvc` |
| `aarch64-pc-windows-msvc`          | `windows-11-arm`   | `win32-arm64-msvc`     | `@boundaryml/baml-core-node-win32-arm64-msvc`         | `nodejs-sdk-aarch64-pc-windows-msvc` |

Notes:
- Linux glibc baseline: same as Python (`manylinux_2_17` for x64,
  `manylinux_2_24` for arm64 — but NAPI doesn't honor manylinux tags
  directly; the napi-rs build base image
  `ghcr.io/napi-rs/napi-rs/nodejs-rust:lts-debian` provides glibc 2.28
  which is widely compatible). If users on RHEL 7 / CentOS 7 report
  load errors, switch the linux-gnu legs to
  `ghcr.io/napi-rs/napi-rs/nodejs-rust:lts-debian-x86_64`'s
  manylinux2014 sibling. Document as a known follow-up.
- The auto-generated `native.js` already has `process.arch` /
  `isMusl()` branches for every entry above (verified in
  `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/native.js:73-414`),
  but the require strings currently embed the **old** `baml_node` /
  `@boundaryml/baml-node-*` names. They are regenerated to
  `baml_core.*` / `@boundaryml/baml-core-node-*` in Phase 6.1 when
  `napi.binaryName` flips to `baml_core` and `napi build` re-emits the
  shim.

## Assumptions

1. **Version lockstep with Python.** `@boundaryml/baml-core-node` and the
   `baml_core` wheel share a single version number bumped in two files by
   the release manager. Alternative considered: independent semver.
   Rejected because the bridge is tightly coupled to the
   `bridge_cffi` ABI and any cross-SDK skew would cause subtle
   protobuf compatibility bugs at install time.
2. **8 targets at launch.** Same as Python. Alternative considered: a
   smaller "primary 4" launch set (linux gnu x64/arm64, darwin
   arm64, win msvc x64). Rejected because the napi-rs CLI already
   wired all 8 in `package.json`, and dropping any of them later is
   strictly easier than adding (consumers' lockfiles pin
   `optionalDependencies`).
3. **NPM trusted publishing.** Alternative: `NPM_TOKEN` secret.
   Documented as fallback in §Phase 6.5 and §Release Runbook.
4. **Node 18 LTS as the floor.** napi-rs 3.x requires Node ≥14; we
   pick 18 to match the modern LTS lower bound the broader JS
   ecosystem expects.
5. **`output_type "nodejs/typescript"` as the generator block
   value.** Alternative: `"node"` or `"typescript"`. Chose
   `"nodejs/typescript"` to mirror the existing
   `"python/pydantic"` two-tier shape (`<language>/<flavor>`).
6. **`workflow_dispatch`-only trigger.** Same as the Python pipeline
   today. The two `TODO`s at the top of `release-sdk.yaml`
   explicitly defer tag-driven triggers; Phase 6 does not resolve
   them.
7. **No cargo-publish of `bridge_nodejs` or `sdkgen_nodejs`.** Both
   are workspace-internal crates (`publish = false` on
   `sdkgen_nodejs`; `bridge_nodejs` has no `publish` flag but isn't
   on crates.io). NPM is the only distribution channel.
8. **Per-platform sub-packages are stub-published once** to reserve
   names. Subsequent publishes overwrite the 0.0.0 reservation with
   the real version. Documented in §Release Runbook.
9. **LICENSE in tarball is a committed file-copy, not a symlink.**
   Rationale: cross-platform git checkouts (Windows) handle symlinks
   inconsistently. The on-disk duplication is 11kB and is gitignored
   from spell-check / docs lints.

## References

### Existing release infrastructure to mirror

- `/Users/sam/baml3/.github/workflows/release-sdk.yaml:22-28` —
  `workflow_dispatch` input shape (single `publish: boolean`). Phase
  6.5 renames to `publish_pypi` and adds `publish_npm`.
- `/Users/sam/baml3/.github/workflows/release-sdk.yaml:38-50` — job
  graph (`build-python-sdk` → `all-builds` gate → conditional
  publish). Phase 6.5 adds `build-nodejs-sdk` as a sibling.
- `/Users/sam/baml3/.github/workflows/release-sdk.yaml:52-84` —
  `publish-to-pypi` job (OIDC trusted publishing, ≥8 wheel guard at
  `:66-75`, `download-artifact@v8` at `:61`). Phase 6.5's
  `publish-to-npm` mirrors this shape.
- `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml:20-56`
  — 8-target matrix structure. Phase 6.2 mirrors verbatim with napi-rs
  swapped in for maturin.
- `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml:58-68`
  — ARM64 Windows rustup bootstrap. Phase 6.2 re-uses verbatim.
- `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml:89-111`
  — maturin invocation + before-script-linux for openssl/perl. Phase
  6.2's napi-build step has no equivalent system-package prereq
  (the napi-rs Docker image preinstalls everything).
- `/Users/sam/baml3/.github/workflows/build-python-sdk.reusable.yaml:113-118`
  — `upload-artifact@v7`, name `python-sdk-${{ matrix._.target }}`,
  `if-no-files-found: error`. Phase 6.2 mirrors with `nodejs-sdk-*`.

### Source-of-truth files

- `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/package.json:1-49`
  — current state (`name: "@boundaryml/baml-node"`, `binaryName:
  "baml_node"`, no `optionalDependencies`); Phase 6.1 renames + extends.
- `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/Cargo.toml:7-19`
  — `[lib] name = "baml_node"`, `crate-type = ["cdylib"]`,
  `test/doctest = false`; `napi` with `napi5` feature at `:33`. Cargo
  `[lib] name` unchanged in Phase 6; only `napi.binaryName` flips.
- `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/native.js:73-414`
  — auto-generated platform-dispatch shim. **Regenerated** in Phase 6.1
  after the `binaryName` rename (not hand-edited).
- `/Users/sam/baml3/baml_language/sdks/python/pyproject.toml:1-11` —
  version source-of-truth for Python (`name = "baml_core"`, `version =
  "0.1.3"`); Phase 6 keeps the same pattern for Node
  (`package.json:version`).
- `/Users/sam/baml3/baml_language/crates/baml_cli/src/generate.rs:148-156`
  — current `OutputType` dispatch (both arms → `codegen_python`).
  Phase 6.6 extends. Help/expected strings at `:116-129` and `:231`.
- `/Users/sam/baml3/baml_language/crates/baml_codegen_types/src/generator_fields.rs:8-16`
  — `OutputType` enum (`PythonPydantic`, `PythonPydanticV1`). Phase 6.6
  adds `NodejsTypescript`.
- `/Users/sam/baml3/baml_language/sdks/nodejs/sdkgen_nodejs/src/lib.rs:18-26`
  — `to_source_code(_pool, _user_baml_files, _naming_convention)` stub
  (`unimplemented!()`). Phase 6 imports as-is; the function body is the
  Phase 2–5 deliverable.
- `/Users/sam/baml3/baml_language/Cargo.toml:6,58` — workspace registers the
  crate (member + path dep) under the old name `codegen_nodejs`; the Phase 2.0
  rename switches both to `sdkgen_nodejs`. `baml_cli/Cargo.toml:33`
  lists `codegen_python` but not yet `sdkgen_nodejs` (Phase 6.6 adds it).

### Phase boundaries

- `/Users/sam/thoughts/sam-projects/bridge-node/00b-overview.md:64-65`
  — Phase 6 scope statement (single sentence: "tie into
  `.github/workflows/release-sdk.yaml`").
- `/Users/sam/thoughts/sam-projects/bridge-node/02-phase2-plan.md` —
  precedent for plan structure / level of detail.
- `/Users/sam/baml3/cliff.toml:1-100` — `git-cliff` config used to
  generate the GitHub release notes referenced in §Release Runbook.
