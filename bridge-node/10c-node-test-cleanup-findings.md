# Node bridge cleanup findings

Context: `jj diff --stat --from canary@origin` is the current Node SDK implementation pass for `00b-overview.md`.

## Cleanup completed in repo

- Removed the new `#[allow(dead_code)]` attributes from `codegen_nodejs` emitter structs and helpers.
- Kept thrown-type names in the Node codegen model and made them live by rendering `@throws <Name>` lines in generated JSDoc for functions and methods.
- Kept class-field and enum-variant docstrings in the Node codegen model and made them live by rendering `Attributes:` and `Members:` JSDoc sections for generated classes and enums.
- Changed the TypeScript stream roundtrip test to import and use `$stream` symbols directly:
  - `Resume$stream` instead of `Resume$stream as StreamResume`
  - `Foo$stream` instead of `Foo$stream as StreamFoo`

## Tests that do not run by default

### `sdks/nodejs/bridge_nodejs/tests/run_jest.rs`

This Rust test is marked `#[ignore]`, so `cargo test`, `cargo nextest run`, and `mise run clippy` do not execute it by default. The body shells out to:

- `pnpm install`
- `pnpm build:debug`
- `pnpm test`

The actual Jest tests live beside it as `*.test.ts` files and are selected by `bridge_nodejs/package.json` (`testMatch: **/tests/**/*.test.ts`). The ignored Rust wrapper duplicates the package script and hides the bridge Jest suite from normal Rust test runs.

Recommendation: delete `run_jest.rs` unless there is a plan to make it an unignored nextest-integrated wrapper with a setup script. If the intended workflow is `pnpm test` from `bridge_nodejs/`, keep that path explicit and remove the ignored Rust test.

### `sdk_tests/crates/typescript_node/host_callables`

This fixture has no `customizable/*.test.ts` files. The harness still emits a `jest` test for every fixture and runs:

```text
node node_modules/jest/bin/jest.js --passWithNoTests
```

For `host_callables`, that Jest test passes only because `--passWithNoTests` converts "no tests found" into success. The fixture still gets `tsc --noEmit` coverage, but it has no runtime Jest coverage.

Recommendation: either add real host-callable TypeScript runtime tests or stop emitting the Jest half for fixtures with no customizable tests. The current generated Jest test is misleading because it reports a passing test that exercised nothing.

### `sdk_tests/crates/python_pydantic2/type_shapes/customizable/test_generic_method.py::test_generic_wrapper_get_value_or_marker`

This test is explicitly skipped with `@pytest.mark.skip`. The reason in the file is still valid: engine-boundary substitution for a class-level `TypeVar` inside a union has not landed, so `WrapperMethods<T>.get_value_or_marker() -> T | WrapperMarker` still lowers `T` incorrectly and rejects a concrete string payload.

Recommendation: keep this skip as a known-red bug pin until the engine substitution work lands. It should not be deleted as redundant; the adjacent enabled `test_generic_wrapper_get_value` covers plain `T`, not `T | Class`.

### `sdk_tests/crates/python_pydantic2/llm_functions/customizable/test_streaming_e2e.py`

These skips are environment/cost gates, not dead tests:

- Most tests are skipped unless `OPENAI_API_KEY` is set.
- `test_stream_100_distinct_inputs` is additionally skipped unless `BAML_STREAM_E2E_FULL=1` is set.

Recommendation: keep these gates. They are intentional live-service controls, not redundant coverage.

## Redundant or misleading tests

### `sdk_tests/crates/typescript_node/type_shapes/customizable/main.test.ts`

The first two sections are useful smoke tests:

- root and namespace importability
- representative symbol reachability

The final section, `type_shapes - typed round-trips`, is now redundant with the split roundtrip files:

- `round_trip_foo` duplicates `roundtrip_routing.test.ts::round_trip_foo`.
- `pick_sentiment` duplicates `roundtrip_enums.test.ts::pick_sentiment`.
- `round_trip_sentiment` duplicates `roundtrip_enums.test.ts::round_trip_sentiment`.

Recommendation: delete the `type_shapes - typed round-trips` block from `main.test.ts` and let the split roundtrip tests own runtime roundtrip coverage. Keep `main.test.ts` as an import/reachability smoke to match the Python `test_main.py`.

### `sdk_tests/crates/typescript_node/docstrings_etc/customizable/main.test.ts`

This file says TypeScript doc-rendering assertions are deferred, and currently it only checks imports plus enum member shape. Now that the Node emitter renders JSDoc, this test no longer pins the behavior it is named for.

Recommendation: replace the enum-shape-only assertions with source-level JSDoc assertions against generated `baml_sdk/docs/index.ts` (or parse with the TypeScript compiler API). The existing enum-member checks are generic shape coverage and are not a strong docstrings test.

### Generated Jest tests for empty fixtures

The TypeScript SDK harness emits a Jest test for every fixture and uses `--passWithNoTests`. This is necessary for fixtures that intentionally rely on `tsc` only, but it makes empty runtime coverage look like a passing Jest suite.

Recommendation: have `harness_setup/src/typescript_node.rs` detect whether `<fixture>/customizable` contains `*.test.ts`; emit the Jest test only when it does. That removes the need for `--passWithNoTests` and makes missing runtime tests visible.
