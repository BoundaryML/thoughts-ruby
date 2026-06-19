# JavaScript and TypeScript module systems

This note explains the module systems that matter when generating, publishing, or consuming JavaScript and TypeScript code.

It uses one repeated local-file example:

- Module A, the imported library module: `src/lib/math`
- Module B, the importing user module: `src/app/main`
- Relative path from B to A: `../lib/math`

The sharp edge is that the correct import specifier may be `../lib/math`, `../lib/math.js`, `../lib/math.cjs`, a package name such as `example-lib`, or a package subpath such as `example-lib/native`. The correct spelling depends on the library format, the user's codebase format, and whether Node or a bundler owns resolution.

## Summary

There are two separate questions that are easy to mix together:

1. What format is the library actually provided in?
2. What format is the user's importing code written and executed in?

TypeScript source syntax does not answer the runtime question by itself. TypeScript can write `import` and `export` syntax and still emit CommonJS. Runtime behavior follows the emitted JavaScript and the resolver that loads it.

The highest-level rules are:

- CommonJS can synchronously load CommonJS with `require(...)`.
- CommonJS cannot synchronously load native ESM. It must use dynamic `import(...)`.
- Native ESM can load native ESM with static `import`.
- Native ESM can usually load CommonJS, but the safest shape is a default import.
- TypeScript `module: "commonjs"` emits `require(...)`, so it has CommonJS runtime constraints.
- TypeScript `module: "nodenext"` follows Node's real rules and usually requires runtime file extensions for relative ESM imports.
- TypeScript `moduleResolution: "bundler"` accepts extensionless imports because the bundler resolves them. That is not the same as plain Node resolution.
- Package `exports` maps are not a module system, but they decide which concrete file an import or require loads.
- Declaration files describe types only. They do not make an incompatible runtime format compatible.

### Library formats in the table

| ID  | Library provided as             | Typical files                                            | Runtime format            |
| --- | ------------------------------- | -------------------------------------------------------- | ------------------------- |
| L1  | CommonJS library                | `.cjs`, or `.js` in a CommonJS package                   | CommonJS                  |
| L2  | Native ESM library              | `.mjs`, or `.js` in a `"type": "module"` package         | ESM                       |
| L3  | TypeScript compiled to CommonJS | `.ts` source, emitted `.js` or `.cjs`                    | CommonJS                  |
| L4  | TypeScript NodeNext ESM         | `.ts` or `.mts` source, emitted `.js` or `.mjs`          | ESM                       |
| L5  | TypeScript bundler-mode library | `.ts` source intended for a bundler, or a bundler output | Depends on emitted bundle |

### User codebase formats in the table

| ID  | User codebase                   | Typical files                                    | Runtime constraint                       |
| --- | ------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| C1  | CommonJS JavaScript             | `.cjs`, or `.js` in a CommonJS package           | Uses `require(...)` for sync loading     |
| C2  | Native ESM JavaScript           | `.mjs`, or `.js` in a `"type": "module"` package | Static imports need Node ESM specifiers  |
| C3  | TypeScript compiled to CommonJS | `.ts` with `module: "commonjs"`                  | Emits `require(...)`                     |
| C4  | TypeScript NodeNext ESM         | `.ts` or `.mts` with `module: "nodenext"`        | Checked against Node ESM rules           |
| C5  | TypeScript bundler-mode app     | `.ts` with `moduleResolution: "bundler"`         | Bundler owns path resolution and interop |

### Compatibility table

This table has one row for every library format and user codebase format combination: 5 library shapes by 5 consumer shapes.

| Row | Library provided as | User codebase | Import shape | Compatibility | Main rule |
| --- | --- | --- | --- | --- | --- |
| R1 | L1 CommonJS | C1 CommonJS JS | `const lib = require("../lib/math.cjs")` | Direct | CommonJS loads CommonJS synchronously. |
| R2 | L1 CommonJS | C2 Native ESM JS | `import lib from "../lib/math.cjs"` | Usually works | Prefer default import; named CJS imports are not fully reliable. |
| R3 | L1 CommonJS | C3 TS compiled to CJS | `import lib = require("../lib/math")` or interop import | Direct after emit | TypeScript emits `require(...)`; declarations control type shape. |
| R4 | L1 CommonJS | C4 TS NodeNext ESM | `import lib from "../lib/math.cjs"` | Usually works | Use the runtime `.cjs` path or package export key. |
| R5 | L1 CommonJS | C5 TS bundler mode | `import lib from "../lib/math"` or package import | Bundler-dependent | Bundler decides extension resolution and CJS interop. |
| R6 | L2 Native ESM | C1 CommonJS JS | `import("../lib/math.js")` inside async code | Async only | `require(...)` cannot load ESM synchronously. |
| R7 | L2 Native ESM | C2 Native ESM JS | `import { add } from "../lib/math.js"` | Direct | Relative imports need the runtime extension in Node ESM. |
| R8 | L2 Native ESM | C3 TS compiled to CJS | `import("../lib/math.js")` inside async code | Async only | Static TS imports usually emit `require(...)`, which fails for ESM. |
| R9 | L2 Native ESM | C4 TS NodeNext ESM | `import { add } from "../lib/math.js"` | Direct | Source imports name the emitted runtime file. |
| R10 | L2 Native ESM | C5 TS bundler mode | `import { add } from "../lib/math"` or package import | Bundler-dependent | Extensionless source can work because the bundler resolves it. |
| R11 | L3 TS compiled to CJS | C1 CommonJS JS | `const lib = require("../dist/math.js")` | Direct | Consumers load the emitted CJS file, not the `.ts` source. |
| R12 | L3 TS compiled to CJS | C2 Native ESM JS | `import lib from "../dist/math.js"` | Usually works | It behaves like any other CommonJS module from ESM. |
| R13 | L3 TS compiled to CJS | C3 TS compiled to CJS | `import { add } from "../dist/math"` | Direct after emit | Both sides end up as CommonJS. |
| R14 | L3 TS compiled to CJS | C4 TS NodeNext ESM | `import lib from "../dist/math.js"` | Usually works | Use emitted runtime extension; default import is safest. |
| R15 | L3 TS compiled to CJS | C5 TS bundler mode | `import { add } from "example-lib"` | Bundler-dependent | Bundler and declarations determine whether named imports work. |
| R16 | L4 TS NodeNext ESM | C1 CommonJS JS | `import("../dist/math.js")` inside async code | Async only | The emitted artifact is ESM. |
| R17 | L4 TS NodeNext ESM | C2 Native ESM JS | `import { add } from "../dist/math.js"` | Direct | Same as native ESM once emitted. |
| R18 | L4 TS NodeNext ESM | C3 TS compiled to CJS | `import("../dist/math.js")` inside async code | Async only | CJS-emitting TypeScript cannot use static imports for ESM runtime. |
| R19 | L4 TS NodeNext ESM | C4 TS NodeNext ESM | `import { add } from "../lib/math.js"` | Direct | In source, write `.js` for a neighboring `.ts` that emits `.js`. |
| R20 | L4 TS NodeNext ESM | C5 TS bundler mode | `import { add } from "../lib/math"` or package import | Bundler-dependent | Bundlers may accept extensionless imports, but plain Node does not. |
| R21 | L5 TS bundler-mode library | C1 CommonJS JS | `const lib = require("./dist/math.cjs")` | Only after CJS output | CommonJS users need a CJS artifact or dynamic import of ESM output. |
| R22 | L5 TS bundler-mode library | C2 Native ESM JS | `import { add } from "./dist/math.js"` | Only after ESM output | Native ESM users need an ESM artifact with Node-valid specifiers. |
| R23 | L5 TS bundler-mode library | C3 TS compiled to CJS | `import lib = require("./dist/math.cjs")` | Only after CJS output | Raw bundler-mode TS is not a stable CJS runtime target. |
| R24 | L5 TS bundler-mode library | C4 TS NodeNext ESM | `import { add } from "./dist/math.js"` | Only after ESM output | NodeNext users need emitted extension-correct ESM. |
| R25 | L5 TS bundler-mode library | C5 TS bundler mode | `import { add } from "../lib/math"` | Direct inside the bundle graph | This is the mode extensionless TS source imports are designed for. |

## Module evaluation timing

A module file is executable code. Any function call at the top level runs when the module body is evaluated.

Example module A:

```js
export function add(left, right) {
  return left + right;
}

console.log("math module loaded");
const startupValue = add(1, 2);
```

The `console.log` and `add(1, 2)` run when the runtime evaluates module A. They do not wait until another file calls `add`.

In most JavaScript module systems:

1. A module is evaluated the first time it is imported, required, or loaded.
2. A module is usually evaluated once per runtime/module cache. Later imports get cached exports.
3. Top-level code runs before the importing module can continue using the imported values.
4. Dependencies generally evaluate before importers.
5. Cycles are special. A module may observe partially initialized exports from another module during circular loading.

So if B imports A:

```js
import { add } from "../lib/math.js";

console.log("main module loaded");
```

the usual order is:

```text
math module loaded
main module loaded
```

Top-level calls execute at module evaluation time, not at function-call time by a consumer.

## CommonJS

CommonJS is Node's original module system. It is synchronous and built around `require`, `exports`, and `module.exports`.

### Module A: `src/lib/math.cjs`

```js
function add(left, right) {
  return left + right;
}

console.log("evaluating math.cjs");
const startupValue = add(1, 2);

module.exports = {
  add,
  startupValue,
};
```

### Module B: `src/app/main.cjs`

```js
const { add } = require("../lib/math.cjs");

console.log(add(1, 2));
```

When `main.cjs` reaches `require("../lib/math.cjs")`, Node synchronously loads and evaluates `math.cjs` if it has not already done so. That means `console.log("evaluating math.cjs")` and `add(1, 2)` run during the `require` call.

If another file later runs the same `require("../lib/math.cjs")`, Node returns the cached `module.exports` object. The top-level `startupValue = add(1, 2)` does not run again unless the process has a separate module cache, the resolved filename differs, or the cache is manually cleared.

In older CommonJS code you will often see:

```js
const { add } = require("../lib/math");
```

Node's CommonJS resolver tries extensions such as `.js`, `.json`, and `.node`, so extensionless local imports historically worked. Using `.cjs` is more explicit, especially inside a package that also contains ESM.

## Native ESM

ESM means ECMAScript Modules. It is the standard JavaScript module system and uses static `import` and `export` declarations.

In Node, a `.js` file is treated as ESM when the nearest `package.json` has `"type": "module"`. A `.mjs` file is always ESM. A `.cjs` file is always CommonJS.

### Module A: `src/lib/math.js`

```js
export function add(left, right) {
  return left + right;
}

export const version = "1.0.0";

console.log("evaluating math.js");
export const startupValue = add(1, 2);
```

### Module B: `src/app/main.js`

```js
import { add } from "../lib/math.js";

console.log(add(1, 2));
```

The `.js` extension matters in native Node ESM. From `src/app/main.js`, the source text must say `../lib/math.js`, not `../lib/math`, unless a custom loader or bundler is involved.

Native ESM has a link/evaluate model:

1. Node parses the whole import graph and links imports to exports.
2. Dependencies are evaluated before their importers.
3. Module A's top-level calls run during A's evaluation.
4. Module B's body runs only after A has evaluated, except for cycles and top-level `await` details.

Native ESM also supports top-level `await`:

```js
export const config = await loadConfig();
```

If module A has top-level `await`, importers of A wait for that promise to settle before their own bodies evaluate. Generated libraries should avoid top-level `await` unless the whole package is explicitly designed for async module initialization.

## TypeScript compiled to CommonJS

This is TypeScript syntax at authoring time, but CommonJS at runtime. It is common in older Node projects and many test setups.

Typical `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "es2020"
  }
}
```

### Module A: `src/lib/math.ts`

```ts
export function add(left: number, right: number): number {
  return left + right;
}

console.log("evaluating math.ts");
export const startupValue = add(1, 2);
```

### Module B: `src/app/main.ts`

```ts
import { add } from "../lib/math";

console.log(add(1, 2));
```

TypeScript emits CommonJS that looks roughly like:

```js
const math_1 = require("../lib/math");
```

Because the output is CommonJS, extensionless local imports are usually okay.

Runtime timing follows the emitted CommonJS, not the TypeScript syntax. After compilation, `main.js` contains a `require("../lib/math")`. When that `require` runs, the emitted `math.js` module body runs once and initializes `startupValue`.

This distinction matters for generated code: TypeScript source can look like ESM, while the actual runtime behavior is CommonJS if `tsconfig` emits CommonJS.

## TypeScript NodeNext / Node16 ESM

`module: "nodenext"` and `moduleResolution: "nodenext"` make TypeScript follow Node's ESM and CommonJS rules. This is the mode to use when emitted files will run directly in Node without a bundler.

Typical `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022"
  }
}
```

### Module A: `src/lib/math.ts`

```ts
export function add(left: number, right: number): number {
  return left + right;
}

console.log("evaluating math.ts as Node ESM");
export const startupValue = add(1, 2);
```

### Module B: `src/app/main.ts`

```ts
import { add } from "../lib/math.js";

console.log(add(1, 2));
```

This looks strange because the source file is `math.ts`, but the import says `math.js`. That is intentional. TypeScript typechecks against `math.ts`, then emits JavaScript where the import path still points to the runtime output file, `math.js`.

If the source file is `.mts`, it emits `.mjs`, so B imports A like this:

```ts
import { add } from "../lib/math.mjs";
```

If the source file is `.cts`, it emits `.cjs`, and the file is CommonJS.

Evaluation timing follows the emitted module kind:

- `.ts` in a `"type": "module"` package and `.mts` emit ESM, so top-level calls run during ESM evaluation.
- `.ts` in a `"type": "commonjs"` package and `.cts` emit CommonJS, so top-level calls run during `require`.

The import specifier is written for the emitted file because that is what executes at runtime. In the `.ts` to `.js` ESM case, a top-level call in `math.ts` runs when Node evaluates the emitted `math.js`.

## TypeScript bundler mode

`moduleResolution: "bundler"` tells TypeScript to accept imports the way Vite, Webpack, Rollup, Bun, or esbuild usually do. This is convenient for app code, but it is not the same as Node runtime resolution.

Typical `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022"
  }
}
```

### Module A: `src/lib/math.ts`

```ts
export function add(left: number, right: number): number {
  return left + right;
}

console.log("evaluating math.ts in the bundle");
export const startupValue = add(1, 2);
```

### Module B: `src/app/main.ts`

```ts
import { add } from "../lib/math";

console.log(add(1, 2));
```

The extensionless import works because the bundler resolves `../lib/math` to `../lib/math.ts` during build.

Evaluation timing depends on the bundle output:

- In an ESM bundle, module A's top-level calls run when the ESM bundle/module graph evaluates.
- In a CommonJS bundle, module A's top-level calls usually run the first time the bundled module function is required by the bundle runtime.
- In a single-file browser bundle, module A's top-level calls often run during initial script execution, before application startup code continues.
- With code splitting, module A's top-level calls may be delayed until the chunk containing A is loaded.

Bundlers also perform tree shaking. If module A is considered unused and side-effect-free, the bundler may remove it. If module A has top-level calls, the package should not claim it is side-effect-free unless those calls can safely disappear.

Example `package.json` setting that can affect this:

```json
{
  "sideEffects": false
}
```

That tells bundlers they may drop unused files. It is risky for modules that intentionally do top-level registration, logging, initialization, or polyfills.

## Package `exports` maps and dual packages

Package exports are not a separate module system, but they control how package specifiers resolve.

Example package:

```json
{
  "name": "example-lib",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./native": {
      "types": "./dist/native.d.ts",
      "import": "./dist/native.js"
    }
  }
}
```

ESM consumer:

```js
import { add } from "example-lib";
import { NativeThing } from "example-lib/native";
```

The consumer imports `example-lib/native`, not `example-lib/native.js`, unless the package explicitly exposes `"./native.js"` too.

Evaluation timing is determined after the export map chooses a concrete file:

- `import { add } from "example-lib"` chooses the `"import"` target and evaluates that ESM file.
- `require("example-lib")` chooses the `"require"` target, if present, and evaluates that CommonJS file.
- If both conditions point to different files, each file has its own top-level initialization.

That last point matters for dual packages. This package:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

has two separate runtime entrypoints. If both are loaded in one process, top-level initialization may run once in `index.js` and once in `index.cjs`.

If generated code emits this:

```ts
import { NativeThing } from "example-lib/native.js";
```

then the package must include:

```json
{
  "exports": {
    "./native.js": {
      "types": "./dist/native.d.ts",
      "import": "./dist/native.js"
    }
  }
}
```

Relative imports and package subpath imports have different rules:

- Relative ESM import: include runtime extension, such as `../lib/math.js`.
- Package subpath export: match the exact exported key, such as `example-lib/native`.

## TypeScript declaration files

`.d.ts` files describe JavaScript modules to TypeScript. They do not define runtime behavior.

Declaration files are never the source of top-level runtime execution. This declaration:

```ts
export declare function initialize(): void;
```

does not call `initialize`; it only tells TypeScript that such a function exists at runtime.

Even a declaration with a value shape has no runtime effect:

```ts
export declare const startupValue: number;
```

The real top-level execution happens in the JavaScript file described by the declaration, such as `math.js`, `math.cjs`, or a bundled output file.

### ESM-style declarations

```ts
export function add(left: number, right: number): number;
```

ESM TypeScript consumer:

```ts
import { add } from "../lib/math.js";
```

CommonJS TypeScript consumer with `esModuleInterop` or compatible settings may still write:

```ts
import { add } from "../lib/math";
```

Runtime compatibility depends on the emitted JavaScript module, not just the declaration.

### CommonJS `export =` declarations

```ts
declare function add(left: number, right: number): number;

export = add;
```

CommonJS-style TypeScript consumer:

```ts
import add = require("../lib/math");
```

ESM-style TypeScript consumer may need interop flags:

```ts
import add from "../lib/math.cjs";
```

For generated libraries, ESM-shaped declarations are usually simpler if the runtime package is ESM-shaped.

## File extensions and package type

Node uses file extensions and `package.json` to decide how to parse a file.

| File | Meaning |
| --- | --- |
| `.mjs` | Always ESM |
| `.cjs` | Always CommonJS |
| `.js` with `"type": "module"` | ESM |
| `.js` with `"type": "commonjs"` or no `"type"` | CommonJS |
| `.mts` | TypeScript source that emits ESM, usually `.mjs` |
| `.cts` | TypeScript source that emits CommonJS, usually `.cjs` |
| `.ts` | Depends on `tsconfig` and nearest package type under NodeNext |
| `.d.ts` | Type declarations only; no runtime execution |

The parse goal controls both syntax validity and evaluation behavior:

- In CommonJS files, top-level `require(...)` is just a function call that runs when execution reaches it.
- In ESM files, static imports are resolved before the module body evaluates.
- In ESM files, top-level `await` can pause evaluation of dependent modules.
- In `.d.ts` files, nothing evaluates at runtime.

So a top-level call in `math.js` may run under CommonJS or ESM semantics depending on `"type"`:

```json
{
  "type": "module"
}
```

With that package setting, `math.js` is ESM. Without it, Node usually treats `math.js` as CommonJS.

## Detailed compatibility rows

This section expands every row in the summary table.

### R1: CommonJS library to CommonJS JavaScript

Use `require(...)`.

```js
const { add } = require("../lib/math.cjs");
```

This is the most direct CommonJS path. The library evaluates synchronously during the first `require(...)`, and later requires get the cached `module.exports` object.

### R2: CommonJS library to native ESM JavaScript

Use a default import for the CommonJS export object.

```js
import math from "../lib/math.cjs";

console.log(math.add(1, 2));
```

Node can bridge from ESM to CommonJS. Named imports from CommonJS may work when Node can statically infer them, but CommonJS exports are dynamic, so generated code should prefer the default import.

### R3: CommonJS library to TypeScript compiled to CommonJS

Use TypeScript's CommonJS import form, or an interop-enabled default import.

```ts
import math = require("../lib/math");

math.add(1, 2);
```

After emit, this becomes `require(...)`. Type declarations determine whether TypeScript accepts named, default, or `export =` style imports, but runtime loading is still CommonJS.

### R4: CommonJS library to TypeScript NodeNext ESM

Use the actual runtime path, usually with `.cjs`.

```ts
import math from "../lib/math.cjs";

math.add(1, 2);
```

This is like native ESM consuming CommonJS. Default import is safest. If importing through a package export, use the package's exported key instead of a relative file path.

### R5: CommonJS library to TypeScript bundler mode

The source may use package imports or extensionless local imports:

```ts
import math from "../lib/math";
```

Whether this works depends on the bundler's CJS interop rules. Some bundlers synthesize named exports, some prefer default imports, and some behavior changes based on plugin configuration.

### R6: Native ESM library to CommonJS JavaScript

Use dynamic `import(...)`.

```js
async function main() {
  const { add } = await import("../lib/math.js");
  console.log(add(1, 2));
}

main();
```

CommonJS cannot synchronously `require(...)` a native ESM file. The ESM module evaluates when the dynamic import runs, and the promise resolves after the ESM graph has evaluated.

### R7: Native ESM library to native ESM JavaScript

Use static ESM imports with Node-valid specifiers.

```js
import { add } from "../lib/math.js";
```

For relative imports in Node ESM, include the runtime extension. For package imports, use the package name or exact `exports` subpath.

### R8: Native ESM library to TypeScript compiled to CommonJS

Use dynamic `import(...)`, or consume a separate CommonJS build.

```ts
async function main() {
  const { add } = await import("../lib/math.js");
  console.log(add(1, 2));
}
```

A static TypeScript import in `module: "commonjs"` usually emits `require(...)`. That is not a valid way to load native ESM.

### R9: Native ESM library to TypeScript NodeNext ESM

Use the same specifier that the emitted JavaScript will need.

```ts
import { add } from "../lib/math.js";
```

If the neighboring source is `math.ts` and it emits `math.js`, the TypeScript source still imports `../lib/math.js`. If the source is `math.mts`, import `../lib/math.mjs`.

### R10: Native ESM library to TypeScript bundler mode

The bundler may allow extensionless imports:

```ts
import { add } from "../lib/math";
```

This is appropriate when the code is definitely bundled. It is not appropriate for generated code that should run directly in Node without a bundler.

### R11: TypeScript compiled to CommonJS library to CommonJS JavaScript

Consumers load the emitted JavaScript file.

```js
const { add } = require("../dist/math.js");
```

The `.ts` source is not what Node runs. Runtime behavior is the emitted CommonJS behavior.

### R12: TypeScript compiled to CommonJS library to native ESM JavaScript

Import the emitted CommonJS artifact as CommonJS from ESM.

```js
import math from "../dist/math.js";

math.add(1, 2);
```

This has the same interop constraints as any other CommonJS module consumed from ESM. Prefer default import unless the package and runtime clearly support named imports.

### R13: TypeScript compiled to CommonJS library to TypeScript compiled to CommonJS

Both sides compile to CommonJS.

```ts
import { add } from "../dist/math";

console.log(add(1, 2));
```

TypeScript emits `require(...)`. The import path can often be extensionless because CommonJS resolution will handle the emitted JavaScript file.

### R14: TypeScript compiled to CommonJS library to TypeScript NodeNext ESM

Import the emitted runtime file from ESM-shaped TypeScript.

```ts
import math from "../dist/math.js";

math.add(1, 2);
```

Use the `.js` or `.cjs` extension that actually exists after the library build. Default import is the safest CommonJS interop shape.

### R15: TypeScript compiled to CommonJS library to TypeScript bundler mode

Package imports are usually the cleanest path.

```ts
import { add } from "example-lib";
```

The bundler chooses how to interpret the CommonJS output and declaration files. Named imports may be a bundler convenience rather than a native Node guarantee.

### R16: TypeScript NodeNext ESM library to CommonJS JavaScript

Use dynamic import against the emitted ESM file.

```js
async function main() {
  const { add } = await import("../dist/math.js");
  console.log(add(1, 2));
}

main();
```

Once the library is emitted as ESM, CommonJS users face the same async-only loading rule as with any native ESM library.

### R17: TypeScript NodeNext ESM library to native ESM JavaScript

Use normal ESM imports against the emitted runtime file.

```js
import { add } from "../dist/math.js";
```

If the library is imported through a package export, use the exported package key. Do not append `.js` to a package subpath unless that exact subpath is exported.

### R18: TypeScript NodeNext ESM library to TypeScript compiled to CommonJS

Use dynamic `import(...)`, or publish a CommonJS build too.

```ts
async function main() {
  const { add } = await import("../dist/math.js");
  console.log(add(1, 2));
}
```

Static imports in a CJS-emitting TypeScript project are not enough because the emitted code will try to use `require(...)`.

### R19: TypeScript NodeNext ESM library to TypeScript NodeNext ESM

Write imports for the emitted runtime extension.

```ts
import { add } from "../lib/math.js";
```

This is the most important NodeNext habit: a source file can import `../lib/math.js` even though the source file beside it is `math.ts`. TypeScript resolves it for checking, and Node uses it after emit.

### R20: TypeScript NodeNext ESM library to TypeScript bundler mode

Bundler-mode code may import the source or package through extensionless paths.

```ts
import { add } from "../lib/math";
```

That is fine inside a bundle graph. It should not be copied into code that will execute directly in Node ESM, because Node will not add the `.js` extension for relative imports.

### R21: TypeScript bundler-mode library to CommonJS JavaScript

CommonJS users need a CommonJS output artifact.

```js
const { add } = require("./dist/math.cjs");
```

Raw bundler-mode TypeScript source is not a CommonJS runtime target. If only an ESM bundle exists, CommonJS users must use dynamic `import(...)`.

### R22: TypeScript bundler-mode library to native ESM JavaScript

Native ESM users need an ESM output artifact with Node-valid imports.

```js
import { add } from "./dist/math.js";
```

An ESM bundle can work well, but it must not contain unresolved TypeScript-only paths that Node cannot load.

### R23: TypeScript bundler-mode library to TypeScript compiled to CommonJS

The consuming TypeScript project should import a CommonJS artifact or use dynamic import for an ESM artifact.

```ts
import lib = require("./dist/math.cjs");
```

Do not assume a CJS-emitting TypeScript project can consume raw bundler-mode source. Its emitted JavaScript will still have CommonJS constraints.

### R24: TypeScript bundler-mode library to TypeScript NodeNext ESM

NodeNext users should consume an emitted ESM artifact with real runtime extensions.

```ts
import { add } from "./dist/math.js";
```

If the bundler-mode library only exposes extensionless source paths, the NodeNext consumer will need a bundler, a loader, or a different published entrypoint.

### R25: TypeScript bundler-mode library to TypeScript bundler mode

This is the natural home for extensionless TypeScript source imports.

```ts
import { add } from "../lib/math";
```

The bundler resolves the source file, applies TypeScript transforms, chooses output chunk format, and determines when the module evaluates. This is convenient for applications, but it is a poor assumption for generated library code that may run in plain Node.

## Rules for generated code

For generated code that may run directly in Node:

1. Choose the runtime module format first: ESM-only, CommonJS-only, or dual package.
2. If ESM-only, emit ESM syntax only. Do not use `exports`, `module.exports`, `require`, `__dirname`, or `__filename` except via explicit `createRequire` and `import.meta.url`.
3. If ESM-only and importing local generated files, include the emitted runtime extension: `../lib/math.js`.
4. If importing package subpaths, match the package `exports` keys exactly. Do not append `.js` to a package subpath unless the package exports that subpath.
5. If CommonJS-only, use CommonJS output and test from ESM via dynamic `import()` if ESM users matter.
6. If dual package, test both `import "pkg"` and `require("pkg")`.
7. Do not assume TypeScript bundler-mode import paths will run directly in Node.
8. Keep top-level work minimal. A generated module may be imported for types, discovery, bundling, or side-effect analysis before a user actually calls a BAML function.
9. If initialization can fail, consider making it explicit inside a function call rather than running it at import time.
10. If runtime registration must happen at top level, test first import, repeated import, dynamic import, and dual-package import paths.

For the BAML Node bridge specifically, the sharp edge is this distinction:

```ts
// Relative ESM import in generated files:
import { Foo } from "../types/foo.js";

// Package subpath import:
import { defineFunction } from "@boundaryml/baml-core-node";
```

The first path points to an emitted file, so it needs `.js` in native ESM. The second path is controlled by the package's `exports` map, so it should match the exported package key.

For top-level execution, the bridge should be conservative. These are usually safe at module level:

```ts
export const VERSION = "1.0.0";
const symbolName = "user.lorem.extract_resume";
```

These deserve scrutiny at module level:

```ts
initializeRuntime();
loadNativeBinding();
registerGlobalHandler();
readProjectFiles();
connectToServer();
```

They run when the module is imported, not when the user calls the generated function. If a generated file does this:

```ts
import { defineFunction } from "@boundaryml/baml-core-node";

export const extract_resume = defineFunction("user.lorem.extract_resume", "sync", ["text"]);
```

then `defineFunction(...)` runs during module evaluation. That is okay if `defineFunction` only creates a lightweight wrapper. It is risky if `defineFunction` initializes the runtime, loads project files, opens sockets, or performs expensive work.
