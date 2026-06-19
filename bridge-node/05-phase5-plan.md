# Phase 5 Plan: Encode/Decode call_function args (bridge_nodejs proto layer)

## Overview

Phase 5 wires up the value layer of the Node SDK: it makes the protobuf round-trip work for codegen-emitted types. After Phase 4 the user can `import { extract_resume } from "baml_sdk/lorem"` and the binding stub exists, but `await extract_resume({ ... })` still returns a plain `Record<string, unknown>` — the FQN metadata on `BamlValueClass` is ignored. Symmetrically, passing a typed `Resume` instance as an argument hits the inbound encoder's `isPlainObject` branch and silently serializes as `map_value` instead of `class_value`.

Phase 5 rewrites `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts` to mirror `baml_core/proto.py`'s full encode/decode dispatch. The work is concentrated in one runtime file plus a tiny lookup surface on a `BamlTypeMap` (Phase 2 deliverable). No further codegen-emitter work is in scope here — but see the prerequisites note: as of 2026-05-29 the Node bridge has **no `typemap.ts`, no media value classes, and no `BamlStream`** yet, so those Phase 1/2 deliverables are hard upstream dependencies (see "Current State Analysis").

> ⚠ Spec note — relationship to the 10a "simplification". An earlier exploratory pass (`10a-todo-items.md`) shipped a *typemap-free* `proto.ts`: every non-builtin object encodes as `map_value`, decode returns plain `Object.create(null)` for `class_value` / raw string for `enum_value` / bare `BamlHandle` for `handle_value`, and the Rust-side `coerce_arg_to_declared_type` re-types args from the declared signature. The four `00*` spec docs (re-edited 2026-05-29) are now the source of truth and mandate the **opposite**: decode resolves FQN→generated class/enum via the typemap and dispatches `handle_value` to typed media/stream wrappers (matching the Python prior art in `baml_core/proto.py`). Phase 5 implements that spec-aligned behavior; it therefore *reverses* the 10a decode-side simplification on the typed-class / enum / handle paths. The inbound encoder still benefits from Rust-side coercion, but typed instances must round-trip as `class_value` with the FQN, not `map_value`.

## Goal

Delivery criteria:
- The full Node SDK test crate (`sdk_test_nodejs_typescript`) passes: `cargo nextest run -E 'package(/^sdk_test_nodejs_/)'` (the per-fixture `jest` Rust harness at `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/tests/run_jest.rs` plus every per-fixture jest suite under `/Users/sam/baml3/baml_language/sdk_tests/crates/nodejs_typescript/{type_shapes,llm_functions,docstrings_etc,function_calls,host_callables}/{generated,customizable}/main.test.ts`). ⚠ Note: the fixture root is `crates/nodejs_typescript/`, with `generated/` and `customizable/` *subdirs* under each fixture — not `crates/nodejs/customizable/`.
- A typed `class Resume {}` value round-trips: decoding `class_value { name: "user.lorem.Resume", fields: {...} }` returns a `Resume` instance (`value instanceof Resume === true`), and re-encoding that instance as a call argument produces a `class_value` on the wire with the same FQN.
- Media wrappers round-trip: the runtime-owned, `@boundaryml/baml-core-node`-re-exported value classes `Image` / `Audio` / `Video` / `Pdf` (codegen does **not** emit a structural class for these five stdlib types — `00a-spec` "Stdlib Re-Exports") decode from `handle_value` with the appropriate `ADT_MEDIA_*` tag, and encode as `class_value { name: "baml.media.Image", fields: { _data: handle_value } }`. The decoded JS value is the typed wrapper itself (the `_data` envelope is unwrapped on decode per the spec's `Instance` row), not a structural shell. The NAPI class identities for these wrappers are referred to below as `BamlImage`/`BamlAudio`/`BamlVideo`/`BamlPdf` (the native constructor names), which `@boundaryml/baml-core-node` re-exports as `Image`/`Audio`/`Video`/`Pdf`.
- `BamlStream<TStream, TFinal>` round-trips: decoded from `handle_value` with `ADT_TAGGED_HEAP_HANDLE` (FQN `baml.llm.Stream`), encoded back as bare `handle_value` with the same tag. `Stream` is likewise a stdlib re-export from `@boundaryml/baml-core-node`, not a codegen class.
- Union-typed return values unwrap to the inner JS value: the wire `union_variant_value` carries `{ value, metadata }` and the decoder discards the metadata, returning the duck-typed inner value (`00a-spec` `Union` row; Python parity `proto.py:union_variant_value` arm).
- Recursive types and generics round-trip (TS generics are erased; no special machinery is required).
- Error envelope handling matches the spec's "Node error handling": `ok`→decoded value, `error`→**`BamlError`** (carrying decoded value + trace + optional class name), `panic`→**`BamlPanic`** (except `is_exit_panic`, which flushes telemetry and `process.exit`s). ⚠ Spec note: the *current* `proto.ts` throws a generic `Error` for both arms and `errors.ts` does not yet define `BamlPanic` (only `BamlError`, `BamlInvalidArgumentError`, `BamlClientError`, `BamlCancelledError` exist at `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/errors.ts`). Adding `BamlPanic` and routing the two arms to the typed classes is in scope for this phase (see Phase 5.9).
- `proto.test.ts` unit tests give every encode/decode branch isolated red→green coverage, independent of the codegen pipeline.

## Current State Analysis

### What Phases 1–4 leave in place

> ⚠ Spec note — verified against the tree on 2026-05-29: several of the Phase 1/2 prerequisites below **do not yet exist** in `sdks/nodejs/`. They are genuine upstream dependencies for this phase, not "already in place". Flagged inline.

- **Phase 1**: `BamlHandle` (NAPI-RS class) exists at `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/native.d.ts:23` with `constructor(key: HandleKey, handleType: number)` (`HandleKey` = `{ low: number, high: number }`, layout-compatible with protobufjs `Long`, at `native.d.ts:119`). `BamlRuntime.callFunction[Sync]` returns a `Buffer` and accepts a `Buffer` (`native.d.ts:35-37`). **Not yet present**: the media value classes (`BamlImage`/`BamlAudio`/`BamlVideo`/`BamlPdf`) and `BamlStream<TStream, TFinal>` — there are no such NAPI classes in `native.d.ts` and no `_fromHandle`/`_toHandle` members today. These must be delivered by Phase 1 (Python analog: `_from_pyhandle` / `_to_pyhandle` on the media PyO3 classes — `/Users/sam/baml3/baml_language/sdks/python/rust/bridge_python/src/media.rs` — and on `BamlStream` — `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/_stream.py:50-58`). Per `00a-spec` "Stdlib Re-Exports", these five (plus `Stream`) are runtime-owned and re-exported from `@boundaryml/baml-core-node`; codegen never emits a structural body for them.
- **Phase 2**: A `BamlTypeMap` runtime class plus a `setTypeMap(...)` / `getTypeMap()` pair. ⚠ **Not yet present**: there is no `typemap.ts` anywhere under `sdks/nodejs/` as of 2026-05-29, and `sdkgen_nodejs` is a single `src/lib.rs` with no `_typemap.ts` emitter. Phase 2 must deliver both. Python prior art: the `BamlTypeMap` class at `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/typemap.py` (forward lookups `get_class`/`get_enum`/`get_type_alias` at `:86`/`:107`/`…`; reverse lookup `py_type_to_baml_type` at `:145`; `_STDLIB_REVERSE_OVERRIDES` seeds the five media/stream identities at `:18`; `from_lazy_entries` builds the map at `:62`). The codegen-emitted populator `_typemap.py` is rendered by `codegen_python/src/emit/typemap_file.rs`; the Node analog `_typemap.ts` does not exist yet.
- **Phase 3**: `translate_ty` is exhaustive over `Ty` and produces TS source strings. Not consumed at runtime.
- **Phase 4**: Codegen emits TS classes, enums, type aliases, and function bindings via a `defineFunction(fqn, mode, paramNames)` / `defineInstanceFunction(...)` factory (see `00a-example-ts-codegen-type-shapes.md`; Python prior art: `define_function`). Per the `00a` examples, **codegen emits TS classes with a single-arg constructor `constructor(init: { ... }) { Object.assign(this, init); }`** (or explicit field assignment) — confirmed by every class in `00a-example-ts-codegen-type-shapes.md` (`Foo`, `Primitives`, `Ipsum`, …). This is the Pydantic `model_validate(dict)` analog and the construction default `_decodeClass` relies on below.

### What `proto.ts` currently does and is missing

File: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts` (527 lines as of 2026-05-29 — much larger than the old 130-line sketch because it already carries the full host-callable dispatch + bigint plumbing). **It currently has no `BamlTypeMap` import or threading at all** — it reflects the 10a typemap-free simplification on the decode side. The Phase 5 rewrite adds the typemap and the spec-aligned class/enum/handle dispatch.

Inbound `setInboundValue(iv, value, ctx)` (note: it threads an `EncodeCtx { syncMode, registered }`, not a typemap or kwargName, today):
- Handles `null`/`undefined`, `boolean`, `number` (integer→`intValue` / non-integer→`floatValue`), `bigint` (→`bigintValue`, hex), `string`, `Uint8Array`, `BamlHandle`, host callables (`typeof === "function"` → `registerHostCallable` → `handle` with `HOST_VALUE_CALLABLE`), arrays, and plain objects via `isPlainObject` (own `Object.prototype` or `null` prototype → `mapValue`).
- **Already done (correct a vs. the old sketch)**: `bigint` IS handled (the old plan's "No bigint handling" note is stale — see below); host-callable encode/rollback is fully implemented.
- **Missing**: typemap threading + `kwargName` threading, `BamlStream` recurse-to-handle, media-wrapper encode (`class_value { _data: handle }`), codegen-emitted class instance dispatch (`jsTypeToBamlType` reverse lookup), and `int` precision (large `number`→`intValue` still loses precision over 2^53 — `bigint` inputs are fine, but a `number` ≥ 2^53 is not promoted).
- Map entries always use `stringKey`; no `intKey` / `boolKey` / `enumKey` dispatch (`setInboundValue`'s plain-object branch hardcodes `stringKey: k`).

Outbound `decodeValueHolder(holder)` (no typemap arg today):
- Decodes primitives, `bigintValue` (hex), lists, maps, literals (all four legs incl. `bigintLiteral`), union variants, and bare handles correctly.
- Returns a plain `Object.create(null)` for `classValue` — **never constructs a typed class instance**. Drops the FQN on the floor. (This is the 10a simplification; the corrected spec requires a typed instance via `typeMap.getClass(fqn)`.)
- `enumValue` returns the raw variant string (`holder.enumValue.value`) — no `typeMap.getEnum(fqn)` lookup. The corrected spec (`00a-spec` `Variant` row) requires resolving to the generated enum member.
- `handleValue` constructs a bare `BamlHandle` regardless of `handle_type` — no `ADT_MEDIA_*` → media-wrapper, no `ADT_TAGGED_HEAP_HANDLE` → stream/typed-handle wrap, no `HANDLE_UNSPECIFIED` rejection.
- `unionVariantValue` recurses correctly into `.value` (already mirrors the spec's metadata-drop behavior).
- The trailing `return null` silently swallows unknown oneofs (incl. any `mediaValue`/`promptAstValue`) — the corrected spec requires throwing `BamlError` for inline `media_value`/`prompt_ast_value` (they must ride via `handle_value`).

Error envelope `decodeCallResult` / `makeThrownError`:
- Already decodes the `BamlOutboundResult` envelope and handles `ok`/`error`/`panic` + `isExitPanic`→`process.exit`. **But it throws a generic `Error` for both `error` and `panic`** (`makeThrownError`), and reads only the class name + a `message` string field off the thrown value. The corrected spec requires `error`→`BamlError` and `panic`→`BamlPanic` carrying the *decoded* value, trace, and optional class name (Python `decode_call_result` arms). `BamlPanic` does not exist in `errors.ts` yet.

### Key reference points (file:line)

- Python encode dispatch (target shape for `setInboundValue`): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:140-321` (`_set_inbound_value`); map-entry key dispatch at `:324-344`.
- Python decode dispatch (target shape for `decodeValue`): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:633-682`.
- Python handle dispatch (target shape for `_decodeHandle`): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:547-589`.
- Python class decode (target shape for `_decodeClass` incl. media `_data` unwrap): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:486-530`.
- Python enum decode: `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:533-544`.
- Python error-envelope arms (`error`→`BamlError`, `panic`→`BamlPanic`/exit): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:694-737`.
- Python typemap (reverse-lookup API the inbound encoder calls): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/typemap.py:145-155`.
- BexExternalValue → wire field mapping (spec, authoritative): `/Users/sam/thoughts/sam-projects/bridge-node/00a-spec-codegen-mappings.md` "BexExternalValue conversions" table; Python reference behavior in `00a-prior-art-python-type-mappings.md` "BexExternalValue conversions".
- Wire schema (read-only): `BamlValueClass.fields` is `repeated BamlOutboundMapEntry` with `string key = 1` (outbound proto `:112-125`); `InboundClassValue.fields` / `InboundMapEntry` use `string_key` (inbound proto `:90-102`); `BamlHandleType` enum at inbound proto `:31-49` (`ADT_MEDIA_IMAGE=6 … ADT_MEDIA_PDF=9`, `ADT_MEDIA_GENERIC=10`, `ADT_TAGGED_HEAP_HANDLE=14`, `HOST_VALUE_CALLABLE=15`, `HANDLE_UNSPECIFIED=0`). Proto files: `/Users/sam/baml3/baml_language/crates/bridge_ctypes/types/baml_core/cffi/v1/baml_{outbound,inbound}.proto`. The generated TS wire types live in `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto/baml_cffi.d.ts` (imported as `baml_core.cffi.v1.*`).

## What We're NOT Doing

- **No further `translate_ty` work** (Phase 3 finished it).
- **No new codegen emitters**. The codegen-emitted `_typemap.ts` populates `setTypeMap(...)` at SDK root import time; we only consume it. The codegen-emitted classes/enums/functions are inputs to this phase.
- **No runtime structural changes to the bridge** (NAPI surface, `BamlRuntime`, `BamlHandle`). Phase 1 settled those.
- **No release pipeline / npm publish work** (Phase 6).
- **No streaming-protocol changes**. `BamlStream` already works against the engine via `baml.llm.Stream.next` / `baml.llm.Stream.final` per Phase 1; Phase 5 only makes encode/decode preserve its identity.
- **No generic runtime parameterization** beyond `typeMap.getClass(fqn)`. TS erases generics, so the `_parameterize` machinery in Python (`proto.py:457-477`, driven by `_baml_ty_to_python_type` at `:392-454`) has no analog (documented as an assumption below — verified by the existing fixture jest tests for `unions` / `generics` / `forward_refs` which only test that the symbols are reachable, never that runtime args propagate). `class_value.name.generic_args` are dropped on the Node path.
- **No `_handle` / `_data` / `_body` private-field injection on user classes** (Pydantic-private-attr analog from `proto.py:_HANDLE_FIELD_NAMES` at `:483` + `_decode_class` private-attr split at `:521-529`). On Node we assume codegen exposes these as regular instance fields on the generated class (e.g. `Response._body: BamlHandle`); they decode the same as any other field. The only special-case is the stdlib media wrappers' `_data` unwrap, handled in `_decodeClass`.
- **No `media_value` / `prompt_ast_value` decode**. Both throw `BamlError` matching Python's behavior (`proto.py:677-681`) and the `00a-spec` rejection rule (inline media/prompt AST are not expected on the FFI path — they ride via `handle_value`). They never appear on the FFI path.
- **No bool-before-int ordering**. `typeof x === "boolean"` and `typeof x === "number"` don't overlap in JS, so the Python bool-int subclass subtlety (`proto.py:165-168`) is absent (documented as an assumption).
- **`bigint` handling already exists** (correction to the older sketch). `setInboundValue` already accepts `typeof value === "bigint"` and emits `bigintValue` (hex), and `decodeValueHolder` already parses `bigintValue` / `bigintLiteral` via `parseHexBigint`. Per `00a-spec` the BEX `Bigint` variant decodes to JS `bigint` and `Int` decodes to `number` (or, if unsafe, throw / bigint-preserve). So `bigint` is **in scope and already working** — Phase 5 must not regress it. The only remaining `int` gap is a `number` ≥ 2^53 arriving inbound: it is still routed to `intValue` lossily (the spec permits "throw unless bridge-node explicitly chooses a bigint-preserving representation"); leave as a documented known limitation unless a fixture forces the issue.

## Implementation Approach

Rewrite `bridge_nodejs/typescript_src/proto.ts` to thread a `BamlTypeMap` through every recursive call (Python's pattern at `proto.py:633-640`), with the public entry points `encodeCallArgs` / `decodeCallResult` looking up `getTypeMap()` once. Note that `setInboundValue` already threads an `EncodeCtx` for the host-callable sync-guard + rollback; the typemap and `kwargName` are *additional* threaded state, not a replacement — extend `EncodeCtx` (or add params) rather than rip out the existing ctx. Add a sibling `proto.test.ts` that unit-tests every encode/decode branch against synthesized protobuf messages (no native runtime needed). Iterate sub-phase by sub-phase, each red→green via one targeted jest test in the fixture suite plus its `proto.test.ts` neighbor.

The branch order in `setInboundValue` and `decodeValue` must match Python's exactly so wire compatibility cannot drift: `null` first, then primitives, then containers, then `BamlHandle`, then `BamlStream` (→ handle), then media classes (→ class with `_data` handle), then codegen-emitted class instances (last, via the FQN reverse map). Enum dispatch sits between primitives and containers on the inbound side; on the outbound side, the wire's oneof discriminant chooses the branch with no precedence question.

For TS, "is this a codegen-emitted class instance?" cannot use the Python `isinstance(value, pydantic.BaseModel)` short-circuit — TS classes don't carry a common base. We instead use the reverse-lookup pattern: `typeMap.jsTypeToBamlType(value.constructor)` (Python analog: `py_type_to_baml_type` at `typemap.py:145-155`, which keys the reverse map on `(cls.__module__, cls.__qualname__)`) — returns the FQN if `value.constructor` (walking the prototype chain) is in the reverse map, `""` otherwise. A non-empty FQN means it's a codegen class. This requires the typemap's reverse map to be populated; in Python `from_lazy_entries` seeds it (`typemap.py:62-81`) and `_STDLIB_REVERSE_OVERRIDES` (`typemap.py:18`) pre-seeds the five media/stream identities. We extend the same pattern to TS, keying the reverse map on the constructor function identity (TS has no `(module, qualname)` analog).

The codegen-emitted class instance is iterated via `Object.entries(value)` (Python uses `dict(value)` on the Pydantic instance). Same trap as Python: must not call `JSON.stringify` / serialize semantics — we want raw field values. `Object.entries` iterates own enumerable string-keyed properties, which matches what the constructor `Object.assign(this, fields)` produces.

## Phase 5.1: Outbound `class_value` decoding via typemap

### Overview

Make `decodeValue` thread a `BamlTypeMap` and turn `class_value` into a typed instance via `typeMap.getClass(fqn)`.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- Rename `decodeValueHolder` → `decodeValue(holder, typeMap)`. Thread `typeMap` through every recursive call.
- Add module-private `_decodeClass(classValue, typeMap)` (Python analog `_decode_class`, `proto.py:486-530`):
  - Decode each field first into a `fieldDict: Record<string, unknown>`. The outbound `BamlValueClass.fields` are `BamlOutboundMapEntry` with a plain `string key = 1` (outbound proto `:112-125`) — read `entry.key` / `entry.value` (this matches the existing `classValue` loop in `decodeValueHolder`). Do **not** confuse with the inbound `string_key`.
  - `const fqn = classValue.name?.name ?? ""`. Throw `BamlError(\`Empty FQN on class_value\`)` if empty.
  - `const Cls = typeMap.getClass(fqn)` — throws `BamlError` if unknown.
  - **Construction default**: `new Cls(fieldDict)` (codegen emits `constructor(init: …) { Object.assign(this, init); }` — confirmed by every class in `00a-example-ts-codegen-type-shapes.md`). If a fixture instead emits a no-arg constructor, fall back to `Object.assign(Object.create(Cls.prototype), fieldDict)`; documented fallback.
  - Media-wrapper unwrap: `if ((Cls === BamlImage || Cls === BamlAudio || Cls === BamlVideo || Cls === BamlPdf) && "_data" in fieldDict)` return `fieldDict._data` — which is already the typed media wrapper, because the inner `_data` field's `handle_value` (carrying `ADT_MEDIA_*`) was decoded by `_decodeHandle` (5.3) into the runtime wrapper. ⚠ Spec note: per `00a-spec` `Instance` row + "Stdlib Re-Exports", the decoded media value is the runtime-owned wrapper itself (the `_data` envelope is discarded), **not** a structural `{ _data }` object — so the unwrap is mandatory, mirroring Python `proto.py:509-510`. In practice the engine usually emits media as a bare `handle_value` (which never reaches `_decodeClass`); the `class_value { _data }` form is the inbound/round-trip shape, so this unwrap is the symmetric decode for it.
- Update `decodeCallResult(data)` to read the typemap once via `getTypeMap()` and pass it in.

**Assumption (now confirmed by `00a-example-ts-codegen-type-shapes.md`)**: Codegen emits TS classes with constructor `constructor(init: { ... }) { Object.assign(this, init); }`. If a fixture deviates, swap to `Object.assign(Object.create(Cls.prototype), fieldDict)` in `_decodeClass`. Verify against the first fixture-emitted class in `nodejs_typescript/llm_functions/customizable/` (e.g. `Resume`).

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"_decodeClass returns a typed Resume instance"` passes (synthesized `BamlValueClass` with a hand-built `BamlTypeMap`).
- [ ] `proto.test.ts::"_decodeClass throws BamlError on unknown FQN"` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_extract_resume_returns_typed_resume)'` passes (where this test is added to `/Users/sam/baml3/baml_language/sdk_tests/crates/nodejs_typescript/llm_functions/customizable/main.test.ts` — mirrors the python `test_extract_resume_returns_typed_resume` from `test_llm_e2e.py` if/when it exists; otherwise the simpler `instanceof Resume` check on the result of a recorded-fixture call).
- [ ] `tsc --noEmit` still passes for every fixture.

#### Manual Verification:
- [ ] `console.log((await extract_resume({ x: "..." })) instanceof Resume)` prints `true` inside a fixture jest run.

---

## Phase 5.2: Outbound `enum_value` decoding via typemap

### Overview

Replace `holder.enumValue.value` raw-string return with `typeMap.getEnum(fqn)[variant]`.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- Add module-private `_decodeEnum(enumValue, typeMap)` (Python analog `_decode_enum`, `proto.py:533-544`):
  - `const fqn = enumValue.name?.name ?? ""`. Throw on empty.
  - `const Cls = typeMap.getEnum(fqn)`.
  - `const variant = enumValue.value`. Validate: `if (!(variant in Cls)) throw new BamlError(...)` (Python parity: `cls(variant)` raising `ValueError`→`BamlError` at `proto.py:538-544`). Codegen-emitted enums are TS string `enum`s (`00a-spec`: `enum Sentiment { Positive = "Positive", ... }`); for string enums `Sentiment.Positive === "Positive"` and `"Positive" in Sentiment === true` (string enums emit only forward entries, so `variant in Cls` is the correct membership check).
  - Return `Cls[variant]`.

**Assumption**: Codegen emits string-valued TS enums (`enum Sentiment { POSITIVE = "POSITIVE", ... }`). This makes the enum value a primitive `string` at runtime, matching the Python `Sentiment.POSITIVE.value === "POSITIVE"` shape and round-tripping through JSON. Documented.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"_decodeEnum returns a typed Sentiment value"` passes.
- [ ] `proto.test.ts::"_decodeEnum throws on unknown variant"` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_classify_sentiment_returns_typed_enum)'` passes (new test added to `nodejs_typescript/llm_functions/customizable/main.test.ts`).

#### Manual Verification:
- [ ] An await on a `classify_sentiment(...)` result `=== Sentiment.POSITIVE` (not `=== "POSITIVE"`) inside a fixture jest run.

---

## Phase 5.3: Outbound `handle_value` dispatch (media + stream + bare handle)

### Overview

Replace the bare-`BamlHandle` decode with a `handle_type` dispatch table mirroring Python's `_decode_handle` at `proto.py:547-589`.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- Add module-private `_decodeHandle(handle, typeMap)`:
  - Construct `const bh = new BamlHandle(handle.key, handle.handleType ?? 0)` from the wire's `key` (a protobufjs `Long`, layout-compatible with the `HandleKey` interface `{ low, high }` at `native.d.ts:119`). The existing `decodeValueHolder` already does exactly this for the bare-handle case — keep that construction and add the dispatch around it.
  - Dispatch on `handle.handleType` (compare against `baml_core.cffi.v1.BamlHandleType` enum values — already imported as `BamlHandleType` in `proto.ts`; alias as `HT` for readability if desired). Enum values per inbound proto `:31-49`:
    - `HT.ADT_MEDIA_IMAGE` (6) → `BamlImage._fromHandle(bh)`
    - `HT.ADT_MEDIA_AUDIO` (7) → `BamlAudio._fromHandle(bh)`
    - `HT.ADT_MEDIA_VIDEO` (8) → `BamlVideo._fromHandle(bh)`
    - `HT.ADT_MEDIA_PDF` (9) → `BamlPdf._fromHandle(bh)`
    - `HT.ADT_TAGGED_HEAP_HANDLE` (14) → look up class FQN from `handle.name?.name`. `const Cls = typeMap.getClass(fqn)`; return `Cls._fromHandle(bh)`. This covers `BamlStream` (FQN `baml.llm.Stream`) and any future tagged-heap typed wrappers. Python parity: `proto.py:574-581`.
    - `HT.HANDLE_UNSPECIFIED` (0) → `throw new BamlError("BEX emitted HANDLE_UNSPECIFIED (Rust-side bug)")` (Python parity `proto.py:582-583`; required by `00a-spec` `Handle` row).
    - default → return `bh` (bare handle). Covers `UNTAGGED_RUST_DATA` (1), `UNTAGGED_BEX_HEAP` (2), `FUNCTION_REF` (5), `ADT_MEDIA_GENERIC` (10), `ADT_PROMPT_AST`, `ADT_COLLECTOR`, `ADT_TYPE`, `HOST_VALUE_CALLABLE` (15). Mirrors `proto.py:585-589`. (Per `00a-spec`, `ADT_MEDIA_GENERIC` decodes to a bare `BamlHandle` — only the four concrete media kinds get typed wrappers.)

- Wire `decodeValue` `handleValue` branch to call `_decodeHandle(holder.handleValue, typeMap)`.

**Assumption (Phase 1 dependency)**: Each media wrapper and `BamlStream` exposes a `static _fromHandle(h: BamlHandle): T` method on its constructor. ⚠ As of 2026-05-29 these NAPI classes and methods **do not exist yet** in `native.d.ts` — Phase 1 must add them. Python parity is `_from_pyhandle` (media: `bridge_python/src/media.rs`; stream: `_stream.py:50`). If Phase 1 lands a different name (`_fromPyhandle`, etc.), rename references uniformly.

**Assumption on `BamlHandle` lifecycle**: Python's `_decode_handle` calls `take_pyhandle_from_table(handle.key, int(ht))` (`proto.py:561-564`) to take ownership of the heap row. The Node `BamlHandle` constructor (`native.d.ts:23`) stores the key + type and its NAPI-RS finalizer releases the table entry on GC (`native.d.ts:17-28` doc). So `_decodeHandle` constructs `new BamlHandle(key, handleType)` directly and relies on GC-time release — there is no explicit "take" call today. ⚠ Spec note: confirm with Phase 1 that constructing a `BamlHandle` from a decoded key actually *takes/owns* the table row (rather than aliasing it) — if the engine expects an explicit drain (cf. the Rust `handle_table.drain(handle.key)` in `value_decode.rs:74-76` on the inbound side), Phase 1 must expose a `BamlHandle.take(...)` and this sub-phase should call it.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"_decodeHandle wraps ADT_MEDIA_PDF as BamlPdf"` passes.
- [ ] `proto.test.ts::"_decodeHandle wraps ADT_TAGGED_HEAP_HANDLE BamlStream"` passes.
- [ ] `proto.test.ts::"_decodeHandle returns bare BamlHandle for FUNCTION_REF"` passes.
- [ ] `proto.test.ts::"_decodeHandle throws on HANDLE_UNSPECIFIED"` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_media_round_trip)'` passes (new test added under `nodejs_typescript/llm_functions/customizable/`, using `Pdf.from_url(...)` returned across the bridge, mirroring the python `test_pdf_round_trip` if present).

#### Manual Verification:
- [ ] `(await fetchPdf({...}) instanceof BamlPdf) === true` inside a fixture jest run.
- [ ] `await stream.next()` returns a `StreamFinished` / `StreamNoYield` typed instance, not a bare `BamlHandle`.

---

## Phase 5.4: Outbound `union_variant_value` + `literal_value` + error paths

### Overview

Verify union metadata strip, ensure `literal_value`'s three legs (`stringLiteral`, `intLiteral`, `boolLiteral`) are decoded, and turn the `media_value` / `prompt_ast_value` branches into explicit `BamlError` throws.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- `unionVariantValue` branch: already correct (recurses into `.value`). Add an explanatory comment matching `proto.py:671-674` ("union metadata discarded — TS is duck-typed; the inner value self-describes"). This satisfies the `00a-spec` `Union{value,metadata}`→unwrap-to-inner rule.
- `literalValue` branch: keep the four-leg switch (`stringLiteral`/`intLiteral`/`boolLiteral`/`bigintLiteral`) — the current code already handles all four including the hex `bigintLiteral` via `parseHexBigint`. `intLiteral` uses `Number(...)` which can lose precision over 2^53; acceptable per parity with `intValue`, document as a known limitation. The spec's `literal_value` row says the decoder unwraps to the inner primitive and discards the typed envelope — current behavior already matches.
- `mediaValue` and `promptAstValue` branches: add explicit branches that `throw new BamlError(\`BEX emitted '${variant}' on the FFI path — media/prompt AST are expected via handle_value, not inline\`)` matching `proto.py:677-681` and the `00a-spec` rejection rule. Without these, the silent `return null` fallthrough at the end of `decodeValueHolder` hides a contract violation.
- Replace the trailing silent `return null` with a `throw new BamlError(\`Unhandled BamlOutboundValue oneof\`)`. This is a divergence from current code's "FIXME: silent collapse to null" (and from Python's matching silent `return None` at `proto.py:682`) — but since the corrected spec gives full oneof coverage, the silent fallthrough has no legitimate case left. ⚠ Spec note: the `null_value`/absent-oneof case must still return `null` (not throw) — keep the explicit `nullValue`/`undefined` early-return; only the *unrecognized* oneof throws.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"union_variant_value unwraps to inner"` passes.
- [ ] `proto.test.ts::"literal_value decodes stringLiteral/intLiteral/boolLiteral"` passes.
- [ ] `proto.test.ts::"media_value throws BamlError"` passes.
- [ ] `proto.test.ts::"prompt_ast_value throws BamlError"` passes.
- [ ] `proto.test.ts::"unknown oneof throws BamlError"` passes.

#### Manual Verification:
- [ ] None — pure protocol-layer checks, fully covered by unit tests.

---

## Phase 5.5: Inbound class encoding (typed instance → `class_value`)

### Overview

Add a codegen-class branch to `setInboundValue` that, on detecting a typed instance, emits `class_value` (`InboundClassValue`) with the engine FQN and recursive field encode. Detection via `typeMap.jsTypeToBamlType(value.constructor)`.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- Rename `setInboundValue(iv, value)` → `setInboundValue(iv, value, typeMap, kwargName)`. Thread `typeMap` and `kwargName` through every recursive call. `encodeCallArgs(kwargs)` looks up the typemap once via `getTypeMap()` and passes the top-level kwarg name in.
- After the existing `isPlainObject` branch (and before the final `throw`), add a "typed class instance" branch:
  - Guard: `value !== null && typeof value === "object" && value.constructor && value.constructor !== Object`.
  - `const fqn = typeMap.jsTypeToBamlType(value.constructor)`. If non-empty: emit as `class_value { name: fqn, fields: [...] }` by iterating `Object.entries(value)` (own enumerable string keys) and recursing.
  - If empty (unknown class): fall through to the existing error throw, but include both `kwargName` and `value.constructor.name` in the message.
- Reorder: the codegen-class branch must precede `isPlainObject` so a typed instance never gets misidentified as a plain object — wait, `isPlainObject` returns `false` for any class with a non-`Object.prototype` prototype, so this ordering already works. But add an explicit comment to document the precedence.

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/typemap.ts` (Phase 2 deliverable; may need extension)

- Add `jsTypeToBamlType(ctor: Function): string` mirroring Python's `py_type_to_baml_type` at `typemap.py:145-155`. Walks the prototype chain of the constructor function (`ctor`, then `Object.getPrototypeOf(ctor)`, …, until `Function.prototype`) and looks up each in the reverse map. Returns `""` if no match. (Python keys its reverse map on `(cls.__module__, cls.__qualname__)`; TS keys on the constructor function identity instead — see below.)
- The reverse-map key is the constructor function identity itself (not `(module, qualname)` — TS has no `__module__` analog). Codegen-emitted `_typemap.ts` populates the reverse map at construction by importing every class and mapping `Cls → fqn`. The five stdlib media/stream identities must be pre-seeded (Python analog: `_STDLIB_REVERSE_OVERRIDES`, `typemap.py:18`), keyed on the `@boundaryml/baml-core-node` constructors `BamlImage`/`BamlAudio`/`BamlVideo`/`BamlPdf`/`BamlStream` → `baml.media.{Image,Audio,Video,Pdf}` / `baml.llm.Stream`.
- If Phase 2 only emitted forward entries (Python-style lazy `(module_path, attr_name)`, built by `from_lazy_entries` at `typemap.py:62-81`), Phase 5 extends `BamlTypeMap.fromLazyEntries` to also build the reverse map eagerly (via `import()` of each leaf module at typemap install time). This is a small extension to the typemap module. Document as a Phase 5 task in this sub-phase.

**Assumption (TS class identity)**: Codegen emits each TS class as a single ES module export, so the constructor function identity is process-stable (no duplicate copies of the same logical class). Documented.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"setInboundValue emits class_value for typed Resume"` passes — encoded value's `InboundValue.classValue.name` matches the FQN, `fields` covers every enumerable own field.
- [ ] `proto.test.ts::"setInboundValue throws TypeError with kwargName context for unknown class"` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_round_trip_resume_class_instance)'` passes — fixture test that constructs a `new Resume({...})`, passes it back through a `next_step(resume: Resume)` BAML function, and checks the wire shape via a captured collector log.

#### Manual Verification:
- [ ] None.

---

## Phase 5.6: Inbound enum + media + stream encoding

### Overview

Add branches for codegen enums, media classes (`class_value` with `_data: handle`), and `BamlStream` (recurse to `_toHandle()` → handle).

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- `setInboundValue` dispatch order (mirrors `_set_inbound_value`, `proto.py:140-321`). The existing order already covers most of this; the new branches (stream / media / codegen-class) slot in **before** the `isPlainObject` branch:
  1. `null` / `undefined` → leave oneof unset (existing)
  2. `typeof value === "boolean"` → `iv.boolValue = value` (existing)
  3. `typeof value === "number"` → integer/float discriminant (existing; document the ≥2^53 `intValue` gap)
  4. `typeof value === "bigint"` → `iv.bigintValue` hex (existing — already implemented)
  5. `typeof value === "string"` → plain `stringValue` (existing). **Enum handling — ⚠ Spec note (genuine ambiguity).** The `00a-spec`/Python reference path emits enums via `enum_value` (Python keys off `isinstance(value, enum.Enum)` at `proto.py:211-215`, with a *real* enum object carrying both `.name` and a distinct type). In TS, a codegen-emitted **string enum** value `Sentiment.Positive` is a primitive `"Positive"` at runtime — indistinguishable from `string` — so the encoder has no host-side signal to choose `enum_value` over `string_value` from the value alone. Two options: (a) lean on the Rust-side `coerce_arg_to_declared_type` (`crates/bex_engine/src/conversion.rs:1283`), which re-types a bare string/map against the declared parameter `Ty` — emit `stringValue` and let the engine coerce; or (b) have codegen brand enum values (e.g. a non-primitive wrapper / `Tagged<Name, Variant>`) so the encoder can detect identity and emit `enumValue`. **Recommended default: (a)** for the fixture suite (lowest codegen cost; outbound decode in 5.2 still re-types to `Sentiment.Positive` via the typemap, so user-facing identity is recovered). This is an intentional, documented divergence from the strict Python `enum_value` emission, justified by TS string-enum runtime erasure. If a fixture round-trip fails because the engine cannot disambiguate (e.g. a `string | EnumT` union arm), revisit with option (b). Verify against `customizable/.../enums`.
  6. `value instanceof Uint8Array` → `uint8arrayValue` (existing)
  7. `value instanceof BamlHandle` → `handle: { key, handleType }` (existing; keeps the `HOST_VALUE_CALLABLE` sync-guard)
  8. `typeof value === "function"` → host-callable register (existing)
  9. `value instanceof BamlStream` → recurse: `setInboundValue(iv, value._toHandle(), …)` (lands on the `BamlHandle` branch). Mirrors `proto.py:243-246`.
  10. `value instanceof BamlImage | BamlAudio | BamlVideo | BamlPdf` → emit `classValue { name: typeMap.jsTypeToBamlType(value.constructor), fields: [{ stringKey: "_data", value: <recurse on value._toHandle()> }] }`. Inbound `InboundClassValue.fields` are `InboundMapEntry` with `string_key` (inbound proto `:90-102`) — so use `stringKey: "_data"`. Mirrors `proto.py:252-260`.
  11. Codegen-class instance (Phase 5.5): `classValue` with iterated `Object.entries`, keyed via `stringKey`.
  12. `isPlainObject(value)` → `mapValue` with `stringKey` entries (existing).
  13. Throw `TypeError(...)` with `kwargName`.

- Update the map/class entry emission to dispatch the key on `typeof key` (Python `_set_inbound_map_entry`, `proto.py:324-344`). Today the plain-object branch hardcodes `stringKey`; generalize it:
  - `typeof key === "boolean"` → `boolKey`
  - `typeof key === "string"` → `stringKey`
  - `typeof key === "number"` → `intKey` (lossy over 2^53; document)
  - Otherwise → coerce to string via `String(key)` and use `stringKey` (matches `proto.py:343`).
  - (No `enumKey` branch on the inbound TS side, consistent with the enum-as-string decision above — JS object keys are always strings/numbers, so an enum-keyed map already arrives as a `Record<string, V>`. `extract_string_key` on the Rust side folds enum keys to `"Name::Variant"` (`value_decode.rs:170`), but the TS object key is just the variant string; rely on Rust-side coercion as in step 5.)

**Note**: the enum-as-string decision (step 5) treats TS enum values as plain strings on the wire. The outbound decode (Phase 5.2) still re-types them via the typemap so user-facing values are `Sentiment.Positive` not `"Positive"`; this is purely host-side type recovery and the wire format is symmetric to a plain string.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"setInboundValue for BamlStream emits handle_value"` passes.
- [ ] `proto.test.ts::"setInboundValue for BamlPdf emits class_value with _data handle"` passes.
- [ ] `proto.test.ts::"setInboundValue for enum string emits string_value"` passes.
- [ ] `proto.test.ts::"setInboundMapEntry dispatches boolKey/intKey/stringKey"` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_round_trip_pdf_argument)'` passes (new fixture test passing a `BamlPdf.from_url(...)` into a function declared as `(doc pdf) -> string`).
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_round_trip_stream_argument)'` passes — captures a `BamlStream` from one call, passes it back into `baml.llm.Stream.next`.

#### Manual Verification:
- [ ] None.

---

## Phase 5.7: Generic / recursive / union type verification

### Overview

Confirm that TS's compile-time generic erasure plus the Python-parity union metadata drop work without further machinery. No new code expected; this sub-phase is a verification gate that snaps the existing tests green.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- No code changes expected. Add a one-paragraph header comment documenting:
  - Generic parameterization is a no-op in TS (generic args on `class_value.name.generic_args` are dropped — they're host-source-only metadata; the engine validates against the declared signature anyway).
  - Recursive types Just Work because TS handles cycles via lazy module evaluation; no `defer_name_refs` analog needed.
  - Union metadata is dropped on decode (already implemented).

### Success Criteria

#### Automated Verification:
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(/type_shapes.*recursion/)'` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(/type_shapes.*generics/)'` passes.
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(/type_shapes.*unions/)'` passes.

#### Manual Verification:
- [ ] None.

---

## Phase 5.8: Error envelope → `BamlError` / `BamlPanic`

### Overview

Align `decodeCallResult` with the spec's "Node error handling": `ok`→decoded value, `error`→`BamlError`, `panic`→`BamlPanic` (except `is_exit_panic`→flush+`process.exit`). Today `decodeCallResult` throws a generic `Error` from `makeThrownError` for both arms.

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/errors.ts`

- Add `BamlPanic extends BamlError` (the file currently defines `BamlError`, `BamlInvalidArgumentError`, `BamlClientError`, `BamlCancelledError`, `wrapNativeError` — no `BamlPanic`). The constructor should accept the decoded BAML value, the trace, and an optional class name (or carry them as fields), mirroring Python's `BamlError(value, baml_trace=..., class_name=...)` / `BamlPanic(...)` shape (`proto.py:711-734`, `errors.py`).
- Extend `BamlError` to carry `.value` (decoded), `.bamlTrace` (string[]), and an optional class name, so generated user code can introspect the thrown BAML value (spec: "carries decoded value, trace, optional class name").

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`

- Rework `decodeCallResult`'s `error` / `panic` arms to **decode the payload via `decodeValue(holder, typeMap)`** (not just scrape a `message` string off `class_value`) and throw `BamlError` / `BamlPanic` carrying the decoded value + `trace` + `_outbound_class_fqn`-style class name (Python `decode_call_result`, `proto.py:694-737`; class-FQN helper `_outbound_class_fqn` at `:685-691`). Keep the existing `isExitPanic`→`flushEvents()` (native `flushEvents` exists at `native.d.ts:103`)+`process.exit(code)` path; the spec calls this "process-exit panic flushes telemetry then exits".
- `decodeCallResult` must look up `getTypeMap()` once and thread it into the payload decode (same as the `ok` arm).

⚠ Spec note: the current `makeThrownError` builds a human-readable string with class name + message + indented trace. That string is still useful as the thrown error's `.message`, but the typed value/trace/class-name must be carried as structured fields per the spec — do not drop them in favor of the flattened string.

### Success Criteria

#### Automated Verification:
- [ ] `proto.test.ts::"decodeCallResult error arm throws BamlError carrying decoded value + trace"` passes.
- [ ] `proto.test.ts::"decodeCallResult panic arm throws BamlPanic"` passes.
- [ ] `proto.test.ts::"decodeCallResult exit panic calls process.exit"` passes (mock `process.exit` / `flushEvents`).
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(test_error_arm_throws_baml_error)'` passes.

#### Manual Verification:
- [ ] None.

---

## Phase 5.9: End-to-end fixture sweep

### Overview

Run the full Node SDK test crate green. Address any remaining gaps surfaced by fixtures (typically: a class constructor shape that differs from the Phase 5.1 default, an enum variant name with a colliding string, a missing reverse-map entry).

### Changes Required

**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts` (touch-ups only)
**File**: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/typemap.ts` (touch-ups if reverse-map gaps surface)

- Run `cargo nextest run -E 'package(/^sdk_test_nodejs_/)'`.
- Diagnose each remaining failure as either (a) a `proto.ts` gap, (b) a typemap gap, or (c) a codegen gap (escalate to Phase 4 if so).
- Iterate until green.

### Success Criteria

#### Automated Verification:
- [ ] `cargo nextest run -E 'package(/^sdk_test_nodejs_/)'` is fully green.
- [ ] `cd /Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs && pnpm test` (the bridge_nodejs jest suite, includes `proto.test.ts`) is fully green.
- [ ] `cd /Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs && pnpm tsc --noEmit` is clean.

#### Manual Verification:
- [ ] Smoke-test a real OpenAI streaming call against `nodejs_typescript/llm_functions/customizable/` (requires `OPENAI_API_KEY`): the python prior-art file `test_streaming_e2e.py` is the spec; we add a `streaming.test.ts` jest sibling guarded by the same `OPENAI_API_KEY` skip-if.

---

## BexExternalValue → wire field mapping table (TS receivers)

Ported from `/Users/sam/thoughts/sam-projects/bridge-node/00a-spec-codegen-mappings.md` "BexExternalValue conversions" with the TS-side receiver substituted. "(handle table)" inherited from the spec means the value rides via the handle table; the encode/decode contract here is the Node side of that wire shape.

| `BexExternalValue` variant              | `BamlOutboundValue.value` oneof field          | TS receiver (decoded value)                                                                                                  |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Null`                                  | `nullValue` (`BamlValueNull`)                  | `null`                                                                                                                       |
| `Int(i64)`                              | `intValue` (`int64`)                           | `number` if safe, else throw / bigint-preserve per `00a-spec` (currently `Number(intValue)`, lossy over 2^53 — known limitation) |
| `Bigint(BigInt)`                        | `bigintValue` (`string`, base-16)              | `bigint` (via `parseHexBigint` — already implemented)                                                                       |
| `Float(f64)`                            | `floatValue` (`double`)                        | `number`                                                                                                                     |
| `Bool(bool)`                            | `boolValue` (`bool`)                           | `boolean`                                                                                                                    |
| `String(String)`                        | `stringValue` (`string`)                       | `string`                                                                                                                     |
| `Uint8Array(Vec<u8>)`                   | `uint8arrayValue` (`bytes`)                    | `Uint8Array`                                                                                                                 |
| —                                       | `literalValue` (`BamlTyLiteral`)               | unwrapped inner `string` / `number` / `boolean` via `_decodeLiteral`                                                          |
|                                         |                                                |                                                                                                                              |
| `Array { element_type, items }`         | `listValue` (`BamlValueList`)                  | `unknown[]` (elements recursively decoded)                                                                                   |
| `Map { key_type, value_type, entries }` | `mapValue` (`BamlValueMap`)                    | `Record<string, unknown>` (values recursively decoded)                                                                       |
| `Instance { class_name, fields }`       | `classValue` (`BamlValueClass`)                | typed class instance via `typeMap.getClass(fqn)`, constructed as `new Cls(fieldDict)`                                        |
| `Variant { enum_name, variant_name }`   | `enumValue` (`BamlValueEnum`)                  | `Cls[variant]` where `Cls = typeMap.getEnum(fqn)` — a TS string enum value (`typeof === "string"`)                            |
|                                         |                                                |                                                                                                                              |
| `Union { value, metadata }`             | `unionVariantValue` (`BamlValueUnionVariant`)  | metadata discarded; recursively decode inner value (duck-typed)                                                              |
|                                         |                                                |                                                                                                                              |
| `Handle(Handle)`                        | `handleValue` (`BamlOutboundHandle`)           | dispatch on `handleType`: media → typed media class; tagged-heap → `typeMap.getClass(fqn)._fromHandle(...)`; else bare `BamlHandle` |
| `FunctionRef { global_index }`          | `handleValue` (`FUNCTION_REF`)                 | bare `BamlHandle`                                                                                                            |
| `Adt(Collector(...))`                   | `handleValue` (`ADT_COLLECTOR`)                | bare `BamlHandle`                                                                                                            |
| `Adt(Type(Ty))`                         | `handleValue` (`ADT_TYPE`)                     | bare `BamlHandle`                                                                                                            |
| `Adt(PromptAst(...))`                   | `handleValue` (`ADT_PROMPT_AST`)               | bare `BamlHandle`; inline `promptAstValue` throws `BamlError`                                                                |
| `Adt(Media(Arc<MediaValue>))`           | `handleValue` (`ADT_MEDIA_*`)                  | typed media class (`BamlImage` / `BamlAudio` / `BamlVideo` / `BamlPdf`); inline `mediaValue` throws `BamlError`              |
| `Adt(TaggedHeapHandle { ty, .. })`      | `handleValue` (`ADT_TAGGED_HEAP_HANDLE`)       | `Cls._fromHandle(bh)` where `Cls = typeMap.getClass(handle.name.name)`; covers `BamlStream<...>` and future tagged wrappers  |
| `RustData(Arc<dyn Any>)`                | `handleValue` (`UNTAGGED_RUST_DATA`) (fallback) | bare `BamlHandle`. Wraps onto a containing class's regular fields by virtue of recursive decode — no Pydantic-private analog |
| —                                       | `mediaValue` (`BamlValueMedia`)                | `throw new BamlError(...)` — not expected on FFI path                                                                        |
| —                                       | `promptAstValue` (`BamlValuePromptAst`)        | `throw new BamlError(...)` — not expected on FFI path                                                                        |

### Inbound mirror

| Host value                                                       | `InboundValue.value` oneof field | Notes                                                                       |
| ---------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `null` / `undefined`                                             | (unset)                          |                                                                             |
| `boolean`                                                        | `boolValue`                      |                                                                             |
| `number` (integer)                                               | `intValue`                       | Discriminated by `Number.isInteger`; ≥2^53 still lossy (known limitation)   |
| `number` (non-integer)                                           | `floatValue`                     |                                                                             |
| `bigint`                                                         | `bigintValue`                    | Hex on the wire (already implemented)                                       |
| `string`                                                         | `stringValue`                    | TS string enums emit here too; Rust-side coercer re-validates against decl  |
| `Uint8Array`                                                     | `uint8arrayValue`                |                                                                             |
| `Array<T>`                                                       | `listValue`                      |                                                                             |
| `BamlHandle`                                                     | `handle`                         | Wire field `handle` (peer to `class_value` etc.)                            |
| `BamlStream<TStream, TFinal>`                                    | `handle` (via `_toHandle()`)     | Mirrors `proto.py:143-146`                                                  |
| `BamlImage` / `BamlAudio` / `BamlVideo` / `BamlPdf`              | `classValue` (`_data: handle`)   | FQN from `typeMap.jsTypeToBamlType(value.constructor)`; mirrors `proto.py:152-160` |
| Codegen-emitted class instance                                   | `classValue`                     | FQN reverse-lookup; iterate `Object.entries(value)`                          |
| Plain `Record<string, unknown>` (own/`null` prototype)           | `mapValue`                       | Key dispatch per `_setInboundMapEntry`                                       |
| anything else                                                    | (throws `TypeError`)             | Error includes the offending kwarg name and constructor name                |

---

## Testing Strategy

### Unit tests (new): `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/tests/proto.test.ts`

Fast, no native runtime. Each test builds a `BamlOutboundValue` or `InboundValue` protobuf message by hand (using the generated `baml_cffi` classes from `proto/baml_cffi.d.ts`), wires up a minimal `BamlTypeMap` with stub classes, calls `decodeValue(...)` / `setInboundValue(...)`, asserts on the result. Mirrors the targeted test cases inlined into `proto.py`'s functions — Python has them in pytest under `python/tests/` (not exhaustively shown in 00b2 but referenced via `tests/test_proto.py` in convention). Categories:

- Outbound:
  - `_decodeClass` with simple, nested, and media-class FQNs.
  - `_decodeEnum` with valid and invalid variants.
  - `_decodeHandle` per `handle_type` (media x4, tagged-heap, bare-handle, HANDLE_UNSPECIFIED throw).
  - `_decodeLiteral` for all three legs.
  - `decodeValue` for `union_variant_value`, `null_value`, primitives, and the `media_value` / `prompt_ast_value` throw paths.
- Inbound:
  - Every primitive + container case (preserving today's coverage).
  - `BamlStream` recurses to `handle`.
  - Media classes emit `class_value { _data: handle }` with the correct FQN.
  - Codegen-emitted instances emit `class_value` with iterated fields.
  - Unknown class throws `TypeError` with kwarg name in the message.
  - `_setInboundMapEntry` key dispatch per type.

### Integration tests (existing, drive sub-phase red→green): `/Users/sam/baml3/baml_language/sdk_tests/crates/nodejs_typescript/{fixture}/{generated,customizable}/main.test.ts`

The existing per-fixture `main.test.ts` files act as the integration anchor. Note the current `type_shapes/customizable/main.test.ts` is mostly an *import-and-reachability* check (it imports every namespace and asserts symbols are defined; the bulk of type verification is `tsc --noEmit`) — it does **not** yet exercise round-trip value decode/encode at runtime. The round-trip value tests this phase needs must be added (there is no `roundtrip.test.ts` today; the `RoundTrip*` BAML functions referenced in `10a` are not present in the current `fixtures/type_shapes/baml_src/`). We add new test cases (one per sub-phase) and seed the red→green cycle:
- `llm_functions/customizable/main.test.ts`: add `test_extract_resume_returns_typed_resume` (5.1), `test_classify_sentiment_returns_typed_enum` (5.2), `test_media_round_trip` (5.3), `test_round_trip_resume_class_instance` (5.5), `test_round_trip_pdf_argument` and `test_round_trip_stream_argument` (5.6), `test_error_arm_throws_baml_error` (5.8).
- `type_shapes/customizable/main.test.ts`: confirms recursion/generics/unions namespaces type-check (5.9); add runtime round-trip assertions where the fixtures support them, otherwise keep the existing import/reachability assertions green.

The harness at `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/tests/run_jest.rs` runs `pnpm install && pnpm build:debug && pnpm test` per fixture under nextest, so the cargo-side TDD command is `cargo nextest run -E 'package(/^sdk_test_nodejs_/)'`.

### Per-sub-phase TDD loop

1. Add the unit test to `proto.test.ts` and the targeted integration test to the appropriate fixture's `main.test.ts`.
2. Run `cd /Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs && pnpm test -- proto.test.ts` — see the new unit case fail (red).
3. Implement the proto.ts change.
4. Re-run — see green.
5. Run `cargo nextest run -E 'package(/^sdk_test_nodejs_/) and test(<target>)'` — see green at fixture level.
6. Commit. Move to the next sub-phase.

## References

- Overview: `/Users/sam/thoughts/sam-projects/bridge-node/00b-overview.md`
- Python prior-art cross-reference: `/Users/sam/thoughts/sam-projects/bridge-node/00b2-overview.md`
- Codegen spec (BexExternalValue + TIR mapping tables): `/Users/sam/thoughts/sam-projects/bridge-node/00a-spec-codegen-mappings.md`
- Python encode/decode (the reference implementation): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/proto.py:1-748` (encode `_set_inbound_value` `:140`; decode `decode_value` `:633`; handle `_decode_handle` `:547`; class `_decode_class` `:486`; enum `_decode_enum` `:533`; error envelope `decode_call_result` `:694`)
- Python typemap (reverse-lookup contract): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/typemap.py` (`py_type_to_baml_type` `:145`; `from_lazy_entries` `:62`; `_STDLIB_REVERSE_OVERRIDES` `:18`)
- Python `_typemap.py` emitter (Phase 2 codegen analog): `/Users/sam/baml3/baml_language/sdks/python/rust/codegen_python/src/emit/typemap_file.rs` (no Node `_typemap.ts` emitter exists yet — `sdks/nodejs/sdkgen_nodejs` is a single `src/lib.rs`)
- Rust-side arg coercion the inbound path relies on (enum-as-string, Map→Class): `coerce_arg_to_declared_type` at `/Users/sam/baml3/baml_language/crates/bex_engine/src/conversion.rs:1283`
- Spec docs (authoritative, re-edited 2026-05-29): `00a-spec-codegen-mappings.md` (BexExternalValue + Node error handling) and `00a-prior-art-python-type-mappings.md` (Python reference behavior)
- Python `_stream.py` (`BamlStream` round-trip semantics): `/Users/sam/baml3/baml_language/sdks/python/src/baml_core/_stream.py`
- Python streaming e2e (the "hard mode" parity target): `/Users/sam/baml3/baml_language/sdk_tests/crates/python_pydantic2/customizable/llm_functions/test_streaming_e2e.py`
- Current Node `proto.ts` (the file being rewritten): `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto.ts`
- Generated wire schema (read-only): `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/proto/baml_cffi.d.ts`
- Native bridge surface: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/native.d.ts`
- Public `index.ts` (encode/decode call sites): `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/typescript_src/index.ts`
- Fixture jest entry points: `/Users/sam/baml3/baml_language/sdk_tests/crates/nodejs_typescript/{type_shapes,llm_functions,docstrings_etc}/{generated,customizable}/main.test.ts`
- Jest harness Rust runner: `/Users/sam/baml3/baml_language/sdks/nodejs/bridge_nodejs/tests/run_jest.rs`
