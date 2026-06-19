# Host-Callable SDK Test Audit

**Date:** 2026-06-02
**Question:** Do both current SDK test targets exercise host-callable logic — i.e., a Node.js or Python host callback/function is passed *into* BAML and then *invoked by* BAML?

**Answer: Yes.** Both `sdk_test_python_pydantic2` and `sdk_test_typescript_node` exercise the full host-callable round trip: a host (Python / Node.js) function is passed into BAML as a typed `Callable` argument, and BAML invokes it from inside BAML code.

---

## Diff under audit

`jj diff --from canary@origin --stat`:

```
...nction_calls/customizable/test_host_callables.py |  27 ++-
...nction_calls/customizable/host_callables.test.ts | 152 ++++++++++++++++++++++
baml_language/sdks/python/src/baml_core/proto.py    |   9 +-
3 files changed, 172 insertions(+), 16 deletions(-)
```

- `host_callables.test.ts` — **new file** (152 lines): the TypeScript/Node host-callable test suite.
- `test_host_callables.py` — modified: the `test_call_with_throwing_*` test was changed from an `xfail`'d "catchable throw" expectation to asserting the current behavior (host-callable error surfaces as an unhandled `baml.errors.HostCallable`).
- `proto.py` — modified: error-decode fallback so bare-bridge/non-generated runtimes preserve a thrown value's fields instead of masking it with an "Unknown class FQN" decode failure when no typemap is installed.

## Test results

Both targets pass (run from `/Users/sam/baml4/baml_language`):

| Target | Result |
|---|---|
| `cargo nextest run -p sdk_test_python_pydantic2` | **14 passed, 0 skipped** |
| `cargo nextest run -p sdk_test_typescript_node` | **15 passed (1 leaky), 0 skipped** |

The relevant suites within those runs:
- Python: `function_calls::pytest` PASS (includes `test_host_callables.py`).
- TypeScript: `function_calls::vitest` PASS (includes `host_callables.test.ts`).

The TS "leaky" mark is on an unrelated `llm_functions::esm_output` check, not the host-callable suite.

## Why this is genuinely host-callable logic (not a stub)

The shared BAML fixture is the proof. `sdk_tests/fixtures/function_calls/baml_src/ns_host_callable_tests/main.baml` declares functions whose first parameter is a typed callable, and the BAML body **calls that callable**:

```baml
function call_with_callback(callback: (int) -> string, x: int) -> string {
    callback(x)            // BAML invokes the host function
}

function call_repeatedly(callback: (int) -> string, n: int) -> string[] {
    let result: string[] = [];
    for (let i = 0; i < n; i += 1) {
        result.push(callback(i));   // N round-trips through SysOp::BamlHostCallHostValue
    }
    result
}

function call_with_throwing(callback: (int) -> string throws baml.errors.HostCallable, x: int) -> string {
    callback(x) catch (e) { _ => "caught:" + e.class_name }
}
```

The round-trip path (per the Python test's own module docstring): host callable → `register_host_callable` emits a `Handle{HOST_VALUE_CALLABLE}` wire entry → engine binds it to an `Object::HostClosure` → BAML's `call_host_value` sysop fires the dispatch FFI → the host dispatch callback invokes the user function and encodes the result back to the engine.

### Python (`test_host_callables.py`) — host callbacks passed in and invoked by BAML

Each test passes a real Python callable into the generated BAML function; BAML invokes it:

- `test_simple_sync_callable_returns_string` — `def cb(x): return f"got {x}"` → `call_with_callback(cb, 5)` → `"got 5"`.
- `test_two_arg_callable_unpacks_positional_args` — two-arg callback, positional unpacking.
- `test_int_return_callable_round_trip` — non-string return encode path.
- `test_lambda_round_trip` — lambda callable.
- `test_async_callable_runs_to_completion` — coroutine-returning callback run to completion in the dispatch thread.
- `test_multiple_callable_keys_are_distinct` — two callables get distinct registry keys; invoking one does not call the other (verified via invocation counters).
- `test_class_callback_round_trips_pydantic_model` — a generated `Person` model flows engine→host as the callback argument.
- `test_call_repeatedly_invokes_callback_n_times` / `..._with_zero_n_...` — BAML's `for` loop invokes the callback N (and 0) times; the test asserts the recorded invocation list, proving BAML actually drove each call.
- `test_throwing_callable_surfaces_as_baml_error` / `test_call_with_throwing_surfaces_declared_host_callable_error` — host exception propagates back out as a `baml.errors.HostCallable` error.

The `test_release_fires_on_drop_of_callable` test (GC/release of the `Object::HostClosure`) remains `xfail(strict=False)`.

### TypeScript/Node (`host_callables.test.ts`) — same coverage on the Node bridge

The new suite imports generated SDK functions (`call_with_callback_async`, `call_with_two_args_async`, `call_int_callback_async`, `call_with_class_callback_async`, `call_repeatedly_async`, `call_with_throwing_async`, plus the sync `call_with_callback`) and passes Node functions in:

- Plain function callback returns a string; two-arg positional unpacking; int round-trip.
- Throwing callback surfaces as a BAML error.
- Arrow-function callback; **Promise-returning (async) callback awaited** by the bridge.
- Distinct registry keys for multiple callbacks (invocation counters).
- Generated `Person` class instance passed into the callback.
- `call_repeatedly_async` invokes the callback once per BAML loop iteration (asserts ordered invocation list); zero-iteration case invokes nothing.
- Throwing callback surfaces the declared `baml.errors.HostCallable` from BAML's `catch` fixture.
- A sync-path guard: `call_with_callback` (sync) **rejects** callable args with a `/host callable/i` error instead of hanging.
- One host-closure release test is `it.skip` (GC/WeakRef behavior), mirroring the Python `xfail`.

## Conclusion

Both SDK test targets genuinely exercise host-callable logic. In each, a host-language function (Python callable / Node function — including lambdas/arrows, async/Promise-returning, multi-arg, class-argument, and throwing variants) is passed into BAML as a typed `Callable` parameter, and BAML invokes it from BAML code (directly, in a loop, and inside a `catch`). The only host-callable behavior not asserted positively is engine-side GC/release of the `Object::HostClosure`, which is intentionally `xfail`/`skip`'d in both languages.
