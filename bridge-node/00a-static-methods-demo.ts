// Self-contained demo of the spec3 codegen shape for STATIC class methods (D4),
// alongside the instance-method shape (D3) for contrast.
//
// `defineFunction` / `defineInstanceFunction` below are a tiny stand-in for the
// real `@boundaryml/baml-core-node` runtime: instead of crossing the BAML bridge they
// dispatch to a local registry, so the file runs with plain `tsc` + `node` and we
// can actually observe the TypeScript semantics the spec relies on.
//
// Run:  npx tsc --strict --target es2022 --module commonjs 00a-static-methods-demo.ts
//       node 00a-static-methods-demo.js

// Minimal local assert (keeps the file dependency-free / no @types/node needed).
const assert = {
  ok(cond: unknown, msg?: string): void {
    if (!cond) throw new Error("assert.ok failed: " + (msg ?? ""));
  },
  strictEqual(a: unknown, b: unknown, msg?: string): void {
    if (a !== b) throw new Error(`assert.strictEqual failed: ${a} !== ${b} ${msg ?? ""}`);
  },
  deepStrictEqual(a: unknown, b: unknown, msg?: string): void {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`assert.deepStrictEqual failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)} ${msg ?? ""}`);
    }
  },
};

// ---------------------------------------------------------------------------
// stub runtime (stands in for @boundaryml/baml-core-node)
// ---------------------------------------------------------------------------
type Impl = (...args: any[]) => any;
const REGISTRY: Record<string, Impl> = {};
function register(name: string, impl: Impl): void {
  REGISTRY[name] = impl;
}

// Free / static binding: no receiver. Returns a plain callable.
function defineFunction(name: string, mode: "sync" | "async", _params: string[]): Function {
  return (...args: any[]) => {
    const impl = REGISTRY[name];
    if (!impl) throw new Error(`no impl registered for ${name}`);
    const result = impl(...args);
    return mode === "async" ? Promise.resolve(result) : result;
  };
}

// Instance binding: uses `this` as the synthetic `self`. The generated code
// `.bind(this)`s it at construction time, so `self` never appears at the call site.
function defineInstanceFunction(name: string, mode: "sync" | "async", _params: string[]): Function {
  return function (this: any, ...args: any[]) {
    const impl = REGISTRY[name];
    if (!impl) throw new Error(`no impl registered for ${name}`);
    const result = impl(this, ...args); // self === this
    return mode === "async" ? Promise.resolve(result) : result;
  };
}

// ---------------------------------------------------------------------------
// generated `class Foo` (mirrors the spec3 worked example)
// ---------------------------------------------------------------------------
class Foo {
  v: number;

  constructor(init: { v: number }) {
    this.v = init.v;
  }

  // Static method (D4): `defineFunction`, no receiver, namespaced under Foo.
  static default_foo = defineFunction("user.Foo.default_foo", "sync", []) as () => Foo;
  static default_foo_async = defineFunction("user.Foo.default_foo", "async", []) as () => Promise<Foo>;

  // Instance method (D3): `defineInstanceFunction(...).bind(this)`, `self` dropped.
  bump = defineInstanceFunction("user.Foo.bump", "sync", ["self", "by"]).bind(this) as (by: number) => Foo;
  bump_async = defineInstanceFunction("user.Foo.bump", "async", ["self", "by"]).bind(this) as (by: number) => Promise<Foo>;
}

// The bridge-side implementations the runtime would dispatch to.
register("user.Foo.default_foo", () => new Foo({ v: 0 }));
register("user.Foo.bump", (self: Foo, by: number) => new Foo({ v: self.v + by }));

// ---------------------------------------------------------------------------
// demonstration
// ---------------------------------------------------------------------------
async function main() {
  // 1. Static method: called on the class, no instance needed.
  const base = Foo.default_foo();
  console.log("Foo.default_foo()            =>", base, "| instanceof Foo:", base instanceof Foo);
  assert.deepStrictEqual(base, new Foo({ v: 0 }));
  assert.ok(base instanceof Foo, "static result is a real Foo instance");

  // 2. Static method, detached from the class — still works (no receiver).
  const factory = Foo.default_foo;
  console.log("const f = Foo.default_foo; f() =>", factory());
  assert.deepStrictEqual(factory(), new Foo({ v: 0 }));

  // 3. Static async variant.
  const baseAsync = await Foo.default_foo_async();
  console.log("await Foo.default_foo_async()  =>", baseAsync);
  assert.deepStrictEqual(baseAsync, new Foo({ v: 0 }));

  // 4. Instance method for contrast: `self` is bound, call site passes only `by`.
  const r = new Foo({ v: 5 });
  console.log("new Foo({v:5}).bump(3)         =>", r.bump(3));
  assert.strictEqual(r.bump(3).v, 8);

  // 5. Detached instance method keeps its receiver (bound at construction).
  const bump = r.bump;
  console.log("const g = r.bump; g(1)         =>", bump(1));
  assert.strictEqual(bump(1).v, 6);

  console.log("\nAll assertions passed ✅");
}

main();
