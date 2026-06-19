- handles don't roundtrip: baml_language/sdk_tests/crates/nodejs_typescript/type_shapes/customizable/roundtrip_handles.test.ts
- how does input coercion work?
	- e.g. pass a bunch of data fields into `roundtrip_complex_models`
	- can you use destructuring on a return field?
- stream comments are wrong
	- baml_language/sdks/nodejs/bridge_nodejs/typescript_src/stream.ts
	- need test coverage of stream lifecycle (when do the handles get encoded/re-encoded)
- pkg name - `@boundaryml/baml-core-node`
	- need to support `web` in the future
- is all test coverage actually ported from python?
	- host callables?


  1. Genuine deferred feature work (1 item)

  - proto.ts:345 — typed wrappers for non-media handle-backed stdlib types. ADT_TAGGED_HEAP_HANDLE / RustData handles (e.g. baml.fs.File, baml.http.Response) currently decode to a
  bare BamlHandle instead of a typed instance with its methods. Needs cross-call handle-lifecycle work. This is the only TODO representing real missing functionality — the same gap
  noted in my earlier audit (dimension F). It's larger scope than a one-liner.

  2. Deliberate "left as-is for parity" FIXMEs (3 items — documented non-issues)

  Each is annotated with why it's safe and matches bridge_python:

  - ctx_manager.ts:15 — HostSpanManager is created eagerly in the constructor before the runtime may be initialized. Benign: get()/reset() create fresh managers, and legacy engine/
  was eager too.
  - index.ts:90 — FunctionLog.result returns null for both "no serialized result" and a legitimate BAML null. Same ambiguity as Python; narrow edge case.
  - src/errors.rs:12 — BridgeError::NotInitialized uses Status::InvalidArg and a message referencing the C-API create_baml_runtime. Confirmed unreachable via BamlRuntime. Relatedly,
  BridgeError::NotImplemented (errors.rs:53) is a dormant variant — never constructed anywhere in the bridge.


nits

- codegen_nodejs should be sdkgen_nodejs
- take_handle_from_table, put_handle_into_table need to get added to cffi interface
- build warning to run "cargo test build_diagnostics" is wrong, should be "cargo test -p sdk_test_... build_diagnostics"
-
- CANCELLED- initializeRuntime, getRuntime should be initialize_runtime, get_runtime
- DONE- switch to vitest from jest, things are faster