---
date: 2026-05-29
repository: bridge-node
source_fixture: baml_language/sdk_tests/crates/python_pydantic2/type_shapes/generated/baml_sdk
---

# TypeScript Codegen Examples From Python Type Shapes

This file sketches what generated Node TypeScript `index.ts` files should look like, derived from the Python runtime/stub pairs in:

`baml_language/sdk_tests/crates/python_pydantic2/type_shapes/generated/baml_sdk`

The Python fixture has one package directory per BAML namespace, with `__init__.py` carrying runtime values and `__init__.pyi` carrying the typed surface. Node collapses that pair into a single file: each namespace directory has one `index.ts` that is already fully typed (real `export class`, typed `as` casts on every binding), so there is **no sibling `index.d.ts`** — a separate declaration file would be redundant and risk drifting from the `.ts`.

- one directory per BAML namespace, each containing a single `index.ts` (runtime values + types together; no `.d.ts`)
- container directories only where needed to expose nested public namespace paths without flattening child symbols (their `index.ts` re-exports child namespaces only)
- stream companion types emitted beside their base type in the same `index.ts`, keeping the `$stream` suffix (e.g. `Primitives$stream` alongside `Primitives`) — `$` is a valid TS identifier character, so there is no separate `stream_types/` namespace

The snippets below are representative, not an exhaustive copy of every namespace in the fixture.

## File Layout

Python fixture paths like:

```text
baml_sdk/__init__.py
baml_sdk/__init__.pyi
baml_sdk/primitives/__init__.py
baml_sdk/primitives/__init__.pyi
baml_sdk/symbol_collisions/lorem/__init__.py
baml_sdk/symbol_collisions/lorem/__init__.pyi
baml_sdk/stream_types/primitives/__init__.pyi
```

map to TypeScript output like (one `index.ts` per directory — the `__init__.pyi` stubs have no `.d.ts` counterpart):

```text
baml_sdk/index.ts
baml_sdk/primitives/index.ts
baml_sdk/symbol_collisions/lorem/index.ts
```

Note the absence of a `stream_types/` tree: where Python routes the stream companion of `primitives.Primitives` into `baml_sdk/stream_types/primitives/__init__.pyi`, Node emits it as `export class Primitives$stream` inside `baml_sdk/primitives/index.ts`, beside `Primitives`.

Container directories such as `symbol_collisions/` and `symbol_collisions/fizz/` carry their own `index.ts` to expose nested namespace paths. Those container `index.ts` files only export child namespaces; they must not flatten symbols from child namespace files.

```ts
// symbol_collisions/index.ts
// Mirror of symbol_collisions/__init__.pyi, which does `from . import a / fizz / foo / lorem`.
export * as a from "./a";
export * as fizz from "./fizz";
export * as foo from "./foo";
export * as lorem from "./lorem";

// symbol_collisions/fizz/index.ts
export * as buzz from "./buzz";
export * as foo from "./foo";

// Wrong: this would expose lorem.Ipsum as symbol_collisions.Ipsum.
export * from "./lorem";
```

The Python fixture never collapses a child namespace into its parent. `symbol_collisions/__init__.py` only re-binds the child packages (`a`, `fizz`, `foo`, `lorem`) via `__getattr__`; `Ipsum`, `make_ipsum`, and the other `lorem` symbols stay reachable only as `symbol_collisions.lorem.Ipsum`, never as `symbol_collisions.Ipsum`. TypeScript output must preserve that boundary at every level: a parent module exposes child namespaces, never the symbols inside them.

## Root Package

Derived from `baml_sdk/__init__.py` and `baml_sdk/__init__.pyi`.

### `index.ts`

```ts
import { defineFunction, defineInstanceFunction, initializeRuntime } from "@boundaryml/baml-core-node";
import * as _inlinedbaml from "./_inlinedbaml";
import * as a from "./a";
import * as aliases from "./aliases";
import * as baml from "./baml";
import * as class_refs from "./class_refs";
import * as enums from "./enums";
import * as generics from "./generics";
import * as primitives from "./primitives";
import * as symbol_collisions from "./symbol_collisions";
import * as vendor from "./vendor";

initializeRuntime("baml_src", _inlinedbaml.FILES);

export { a, aliases, baml, class_refs, enums, generics, primitives, symbol_collisions, vendor };

export class Foo {
  v: number;

  constructor(init: { v: number }) {
    this.v = init.v;
  }

  // Static method: bound on the class, no `self`, reached as `Foo.from_value(...)`.
  static from_value = defineFunction("user.Foo.from_value", "sync", ["v"]) as (v: number) => Foo;
  static from_value_async = defineFunction("user.Foo.from_value", "async", ["v"]) as (v: number) => Promise<Foo>;

  // Instance method: `.bind(this)` captures the receiver. `self` travels in the
  // `paramNames` array for marshalling but is dropped from the surface type, so
  // the call site is `foo.describe()`.
  describe = defineInstanceFunction("user.Foo.describe", "sync", ["self"]).bind(this) as () => string;
  describe_async = defineInstanceFunction("user.Foo.describe", "async", ["self"]).bind(this) as () => Promise<string>;
}

export const make_foo = defineFunction("user.make_foo", "sync", ["v"]) as (v: number) => Foo;
export const make_foo_async = defineFunction("user.make_foo", "async", ["v"]) as (v: number) => Promise<Foo>;

export const round_trip_foo = defineFunction("user.round_trip_foo", "sync", ["f"]) as (f: Foo) => Foo;
export const round_trip_foo_async = defineFunction("user.round_trip_foo", "async", ["f"]) as (f: Foo) => Promise<Foo>;
```

The root module does not define an `export const b` client object. Root-namespace functions are plain module exports (`make_foo`, `round_trip_foo`, …), exactly as the root `__init__.py` defines them. The package module itself is the client: users alias the whole package (`import * as b from "baml_sdk"`) and call `b.make_foo(...)`. There is no aggregated client value, so there is nothing to flatten child-namespace functions into.

The `index.ts` imports the child namespaces (`a`, `primitives`, `enums`, …) and re-exports them with `export * as` so that `baml_sdk.primitives`, `baml_sdk.symbol_collisions.lorem`, etc. resolve. Those bindings exist only to forward the namespaces; the root never hoists a symbol out of one, and it declares no `b` client value — root-namespace functions are the only direct exports. Because the `index.ts` is fully typed, no companion `index.d.ts` is emitted.

### Calling functions

The package module is the client. Users alias the whole package as `b` (`import * as b from "baml_sdk"`); root-namespace functions hang off that alias, and namespaced functions are reached through their namespace path — exactly how the Python fixture exposes `baml_sdk.make_foo` at the root and `baml_sdk.primitives.return_int` inside `primitives/__init__.py`:

```ts
import * as b from "baml_sdk";

// Root-namespace functions are direct members of the package.
const foo = await b.make_foo_async({ v: 1 });

// Namespaced functions are reached through the namespace, never hoisted to the root.
const n = await b.primitives.return_int_async();
const ipsum = await b.symbol_collisions.lorem.make_ipsum_async(bar1, bar2, bar3);
```

Wrong — these would require the root to have re-exported child-namespace symbols, which it must not do:

```ts
const n = await b.return_int_async();            // primitives.return_int hoisted to the root
const ipsum = await b.make_ipsum_async(/* … */); // symbol_collisions.lorem.make_ipsum hoisted to the root
```

## Primitive Namespace

Derived from `baml_sdk/primitives/__init__.py` and `baml_sdk/primitives/__init__.pyi`.

### `primitives/index.ts`

```ts
import { defineFunction } from "@boundaryml/baml-core-node";

export class Primitives {
  int_field: number;
  float_field: number;
  string_field: string;
  bool_field: boolean;
  null_field: null;
  uint8array_field: Uint8Array;

  constructor(init: {
    int_field: number;
    float_field: number;
    string_field: string;
    bool_field: boolean;
    null_field: null;
    uint8array_field: Uint8Array;
  }) {
    Object.assign(this, init);
  }
}

export const return_int = defineFunction("user.primitives.return_int", "sync", []) as () => number;
export const return_int_async = defineFunction("user.primitives.return_int", "async", []) as () => Promise<number>;

export const return_float = defineFunction("user.primitives.return_float", "sync", []) as () => number;
export const return_float_async = defineFunction("user.primitives.return_float", "async", []) as () => Promise<number>;

export const return_string = defineFunction("user.primitives.return_string", "sync", []) as () => string;
export const return_string_async = defineFunction("user.primitives.return_string", "async", []) as () => Promise<string>;

export const return_bool = defineFunction("user.primitives.return_bool", "sync", []) as () => boolean;
export const return_bool_async = defineFunction("user.primitives.return_bool", "async", []) as () => Promise<boolean>;

export const return_null = defineFunction("user.primitives.return_null", "sync", []) as () => null;
export const return_null_async = defineFunction("user.primitives.return_null", "async", []) as () => Promise<null>;

export const round_trip_uint8_array = defineFunction("user.primitives.round_trip_uint8_array", "sync", ["b"]) as (b: Uint8Array) => Uint8Array;
export const round_trip_uint8_array_async = defineFunction("user.primitives.round_trip_uint8_array", "async", ["b"]) as (b: Uint8Array) => Promise<Uint8Array>;

export const round_trip_primitives = defineFunction("user.primitives.round_trip_primitives", "sync", ["p"]) as (p: Primitives) => Primitives;
export const round_trip_primitives_async = defineFunction("user.primitives.round_trip_primitives", "async", ["p"]) as (p: Primitives) => Promise<Primitives>;
```

## Enums Namespace

Derived from `baml_sdk/enums/__init__.pyi`.

### `enums/index.ts`

```ts
import { defineFunction } from "@boundaryml/baml-core-node";

export enum Sentiment {
  Positive = "Positive",
  Negative = "Negative",
}

export class Enums {
  bare_enum: Sentiment;
  variant_as_type: Sentiment;

  constructor(init: { bare_enum: Sentiment; variant_as_type: Sentiment }) {
    Object.assign(this, init);
  }
}

export const pick_sentiment = defineFunction("user.enums.pick_sentiment", "sync", ["b"]) as (b: boolean) => Sentiment;
export const pick_sentiment_async = defineFunction("user.enums.pick_sentiment", "async", ["b"]) as (b: boolean) => Promise<Sentiment>;

export const round_trip_enums = defineFunction("user.enums.round_trip_enums", "sync", ["e"]) as (e: Enums) => Enums;
export const round_trip_enums_async = defineFunction("user.enums.round_trip_enums", "async", ["e"]) as (e: Enums) => Promise<Enums>;
```

## Aliases Namespace

Derived from `baml_sdk/aliases/__init__.pyi`.

### `aliases/index.ts`

```ts
import { defineFunction } from "@boundaryml/baml-core-node";

export type RecList = number | RecList[];
export type StringList = string[];

export class AliasContainer {
  list_field: string[];
  rec_field: RecList;

  constructor(init: { list_field: string[]; rec_field: RecList }) {
    Object.assign(this, init);
  }
}

export const round_trip_string_list = defineFunction("user.aliases.round_trip_string_list", "sync", ["s"]) as (s: string[]) => string[];
export const round_trip_string_list_async = defineFunction("user.aliases.round_trip_string_list", "async", ["s"]) as (s: string[]) => Promise<string[]>;

export const round_trip_rec_list = defineFunction("user.aliases.round_trip_rec_list", "sync", ["r"]) as (r: RecList) => RecList;
export const round_trip_rec_list_async = defineFunction("user.aliases.round_trip_rec_list", "async", ["r"]) as (r: RecList) => Promise<RecList>;
```

## Generics And Instance Methods

Derived from `baml_sdk/generics/__init__.py` and `baml_sdk/generics/__init__.pyi`.

### `generics/index.ts`

```ts
import { defineFunction, defineInstanceFunction } from "@boundaryml/baml-core-node";

export class WrapperMarker {
  reason: string;

  constructor(init: { reason: string }) {
    this.reason = init.reason;
  }
}

export class Wrapper<T> {
  value: T;

  constructor(init: { value: T }) {
    this.value = init.value;
  }
}

export class WrapperMethods<T> {
  value: T;

  constructor(init: { value: T }) {
    this.value = init.value;
  }

  // The method binding lives directly on the class as the callable member —
  // no module-level const and no `static readonly` indirection. The field
  // initializer `.bind(this)`s the receiver at construction time, so the
  // synthetic `self` parameter never appears in the surface type, the call site
  // is just `wrapper.get_value()`, and a detached `const f = wrapper.get_value`
  // still carries its receiver.
  get_value = defineInstanceFunction("user.generics.WrapperMethods.get_value", "sync", ["self"]).bind(this) as () => T;
  get_value_async = defineInstanceFunction("user.generics.WrapperMethods.get_value", "async", ["self"]).bind(this) as () => Promise<T>;
  get_value_or_marker = defineInstanceFunction("user.generics.WrapperMethods.get_value_or_marker", "sync", ["self"]).bind(this) as () => T | WrapperMarker;
  get_value_or_marker_async = defineInstanceFunction("user.generics.WrapperMethods.get_value_or_marker", "async", ["self"]).bind(this) as () => Promise<T | WrapperMarker>;
}

export class GenericLinkedList<T> {
  value: T;
  next: GenericLinkedList<T> | null;

  constructor(init: { value: T; next: GenericLinkedList<T> | null }) {
    Object.assign(this, init);
  }
}

export class Box<T> {
  value: T;
  wrapped: Wrapper<T>;

  constructor(init: { value: T; wrapped: Wrapper<T> }) {
    Object.assign(this, init);
  }
}

export const make_wrapper_methods = defineFunction("user.generics.make_wrapper_methods", "sync", ["text"]) as (text: string) => WrapperMethods<string>;
export const make_wrapper_methods_async = defineFunction("user.generics.make_wrapper_methods", "async", ["text"]) as (text: string) => Promise<WrapperMethods<string>>;

export const round_trip_box_int = defineFunction("user.generics.round_trip_box_int", "sync", ["b"]) as (b: Box<number>) => Box<number>;
export const round_trip_box_int_async = defineFunction("user.generics.round_trip_box_int", "async", ["b"]) as (b: Box<number>) => Promise<Box<number>>;
```

Implementation note: an instance-method binding is the class member itself — `get_value = defineInstanceFunction(...).bind(this)` written directly inside the class body. There is no module-level const and no `static readonly` indirection (no separate binding that a hand-written method delegates to). The field initializer `.bind(this)`s the receiver at construction time, so the bound member captures its instance once: the surface type is the user-facing `() => T`, the synthetic `self` parameter never appears at the call site (`wrapper.get_value()`), and a detached reference (`const f = wrapper.get_value; f()`) still carries its receiver. The cost is one bound-function allocation per method per instance. Using `defineInstanceFunction` (rather than `defineFunction`) marks the receiver-binding flavor. Free functions still use module-level `export const … = defineFunction(...)`.

## Cross-Namespace References

Derived from `baml_sdk/symbol_collisions/lorem/__init__.py` and `baml_sdk/symbol_collisions/lorem/__init__.pyi`.

### `symbol_collisions/lorem/index.ts`

```ts
import { defineFunction } from "@boundaryml/baml-core-node";
import type * as symbol_collisions from "..";

export class Ipsum {
  bar1: symbol_collisions.foo.Bar;
  bar2: symbol_collisions.fizz.foo.Bar;
  bar3: symbol_collisions.fizz.buzz.foo.Bar;

  constructor(init: {
    bar1: symbol_collisions.foo.Bar;
    bar2: symbol_collisions.fizz.foo.Bar;
    bar3: symbol_collisions.fizz.buzz.foo.Bar;
  }) {
    Object.assign(this, init);
  }
}

export const make_ipsum = defineFunction("user.symbol_collisions.lorem.make_ipsum", "sync", ["bar1", "bar2", "bar3"]) as (
  bar1: symbol_collisions.foo.Bar,
  bar2: symbol_collisions.fizz.foo.Bar,
  bar3: symbol_collisions.fizz.buzz.foo.Bar,
) => Ipsum;

export const make_ipsum_async = defineFunction("user.symbol_collisions.lorem.make_ipsum", "async", ["bar1", "bar2", "bar3"]) as (
  bar1: symbol_collisions.foo.Bar,
  bar2: symbol_collisions.fizz.foo.Bar,
  bar3: symbol_collisions.fizz.buzz.foo.Bar,
) => Promise<Ipsum>;
```

## Stdlib Re-Exports (unique codegen types)

`baml.media.Image`, `baml.media.Audio`, `baml.media.Video`, `baml.media.Pdf`, and `baml.llm.Stream` are **unique among generated symbols**: codegen does *not* emit a generated `class` body for them. Each one is a re-export of a runtime/standard-library type owned by `@boundaryml/baml-core-node`, because callers need the runtime's constructors, static helpers, and handle identity — a generated structural class would not round-trip.

The runtime exports these classes under their `Baml`-prefixed names (`BamlImage`, `BamlAudio`, `BamlVideo`, `BamlPdf`, `BamlStream`) and does **not** alias them. Codegen does the aliasing on re-export, binding `BamlImage` to the public `Image`, etc., so the generated public surface is `baml_sdk.baml.media.Image`. This mirrors the Python fixture, which re-binds rather than defines them:

```python
# baml_sdk/baml/media/__init__.pyi
from baml_core.baml_py import BamlPdf as Pdf
from baml_core.baml_py import BamlAudio as Audio
from baml_core.baml_py import BamlVideo as Video
from baml_core.baml_py import BamlImage as Image

# baml_sdk/baml/llm/__init__.pyi
from baml_core import BamlStream as Stream
```

Every other generated symbol (user/vendor classes, enums, type aliases, free functions, method bindings) is emitted by codegen into the generated package. These five are the only ones that resolve to a runtime-owned type instead.

### `baml/media/index.ts`

Derived from `baml_sdk/baml/media/__init__.pyi`.

```ts
export { BamlAudio as Audio, BamlImage as Image, BamlPdf as Pdf, BamlVideo as Video } from "@boundaryml/baml-core-node";
export type Audio = import("@boundaryml/baml-core-node").BamlAudio;
export type Image = import("@boundaryml/baml-core-node").BamlImage;
export type Pdf = import("@boundaryml/baml-core-node").BamlPdf;
export type Video = import("@boundaryml/baml-core-node").BamlVideo;
```

### `baml/llm/index.ts`

Derived from `baml_sdk/baml/llm/__init__.pyi`. The `llm` namespace defines many ordinary generated classes/functions (`Client`, `PrimitiveClient`, `render_prompt`, …); `Stream` is the one symbol that is a stdlib re-export rather than a generated class.

```ts
export { BamlStream as Stream } from "@boundaryml/baml-core-node";
export type Stream<TStream, TFinal> = import("@boundaryml/baml-core-node").BamlStream<TStream, TFinal>;

// ... ordinary generated `llm` symbols (Client, PrimitiveClient, render_prompt, ...) follow.
```

## Stream Companion Types

Derived from `baml_sdk/stream_types/primitives/__init__.pyi` and `baml_sdk/stream_types/generics/__init__.pyi`. Where Python isolates these in a `stream_types/` package tree, Node emits each companion **beside its base type in the same `index.ts`**, keeping the `$stream` suffix on the name. `$` is a valid TypeScript identifier character, so `Primitives$stream` and `Primitives` coexist as distinct exports with no separate namespace.

### `primitives/index.ts` (continued)

The `$stream` companion is appended to the same file shown under "Primitive Namespace" above, after `Primitives` and the function bindings:

```ts
export class Primitives$stream {
  int_field: number | null;
  float_field: number | null;
  string_field: string | null;
  bool_field: boolean | null;
  null_field: null;
  uint8array_field: Uint8Array;

  constructor(init: {
    int_field: number | null;
    float_field: number | null;
    string_field: string | null;
    bool_field: boolean | null;
    null_field: null;
    uint8array_field: Uint8Array;
  }) {
    Object.assign(this, init);
  }
}
```

### `generics/index.ts` (continued)

Likewise, each generic class's `$stream` companion sits beside it in `generics/index.ts`:

```ts
export class WrapperMarker$stream {
  reason: string | null;

  constructor(init: { reason: string | null }) {
    Object.assign(this, init);
  }
}

export class Wrapper$stream<T> {
  value: T | null;

  constructor(init: { value: T | null }) {
    Object.assign(this, init);
  }
}

export class WrapperMethods$stream<T> {
  value: T | null;

  constructor(init: { value: T | null }) {
    Object.assign(this, init);
  }
}

export class Box$stream<T> {
  value: T | null;
  wrapped: Wrapper$stream<T> | null;

  constructor(init: { value: T | null; wrapped: Wrapper$stream<T> | null }) {
    Object.assign(this, init);
  }
}
```

A field that references another stream companion uses that companion's `$stream` name (`wrapped: Wrapper$stream<T> | null`), since both live in the same leaf. Stream companion classes do not emit static functions or instance methods. They consume the compiler-produced stream companion shape directly.
