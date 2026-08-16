# @depthbomb/serde

Type-safe JSON ↔ Class serialization for TypeScript

---

## Installation

```sh
yarn add @depthbomb/serde
bun add @depthbomb/serde
npm install @depthbomb/serde
```

Legacy TypeScript decorators use the following setting. Standard ECMAScript field decorators are also supported and do not require `experimentalDecorators`.

```json
{
	"compilerOptions": {
		"experimentalDecorators": true,
		"strict": true
	}
}
```

---

## Quick start

```ts
import { toJSON, serialize, deserialize, Serializable, JSONProperty } from '@depthbomb/serde';

@Serializable()
class User {
	@JSONProperty({ name: 'first_name' })
	firstName!: string;

	@JSONProperty({ name: 'last_name' })
	lastName!: string;

	@JSONProperty()
	age!: number;
}

// Deserialize
const user = deserialize(User, { first_name: 'Leon', last_name: 'Kennedy', age: 49 });
console.log(user.firstName);       // 'Leon'
console.log(user instanceof User); // true

// Serialize
const plain = serialize(user); // { first_name: 'Leon', last_name: 'Kennedy', age: 49 }
const json  = toJSON(user, 2); // pretty-printed JSON string
```

---

## Decorators

### `@Serializable()`

Marks a class as a serialization target. Required for any class used as a nested type.

```ts
@Serializable()
class MyClass { ... }
```

---

### `@JSONProperty(options?)`

Marks a property for (de)serialization. All options are optional.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | property name | JSON key to read/write |
| `aliases` | `string[]` | `[]` | Legacy JSON keys accepted on input |
| `type` | `Constructor \| () => Constructor` | — | Nested class type (use thunk for forward refs) |
| `codec` | `JSONCodec<T>` | — | Reusable typed value ↔ JSON conversion; mutually exclusive with `type` |
| `isArray` | `boolean` | `false` | Property holds `T[]` |
| `isMap` | `boolean` | `false` | Property holds `Map<string, T>` |
| `isSet` | `boolean` | `false` | Property holds `Set<T>` |
| `optional` | `boolean` | `true` | Skip if key absent; `false` = required |
| `nullable` | `'ignore' \| 'null' \| 'error'` | `'ignore'` | Behaviour when value is `null` |
| `defaultValue` | `T \| (() => T)` | — | Default when key is absent |
| `deserializeTransform` | `(raw: unknown) => T` | identity | Post-deserialization transform |
| `serializeTransform` | `(value: T) => unknown` | identity | Pre-serialization transform |
| `validate` | `(value: T) => boolean \| string \| void` | — | Validator; `false`/string throws |
| `deserializeAsyncTransform` | `(value: T) => Promise<T>` | — | Async post-deserialization transform |
| `serializeAsyncTransform` | `(value: T) => Promise<unknown>` | — | Async serialization transform |
| `validateAsync` | `(value: T) => Promise<boolean \| string \| void>` | — | Async validator |
| `groups` | `string[]` | `[]` | Named serialization projections |
| `sensitive` | `boolean` | `false` | Omit unless `includeSensitive` is enabled |

---

### `@JSONDiscriminator(field)` + `@JSONSubType(value, Class)`

Enable polymorphic deserialization using a discriminator field.

```ts
@Serializable()
@JSONDiscriminator('type')
@JSONSubType('circle', Circle)
@JSONSubType('rectangle', Rectangle)
class Shape {
	@JSONProperty() type!: string;
	@JSONProperty() color!: string;
}

// Automatically dispatches to the right subclass:
const s = deserialize(Shape, { type: 'circle', color: 'red', radius: 5 });
console.log(s instanceof Circle); // true
```

---

## API Reference

```ts
// Deserialization
deserialize<T>(ctor: Constructor<T>, data: Record<string, unknown> | string, path?: string, options?: IDeserializeOptions): T
deserializeArray<T>(ctor: Constructor<T>, data: Record<string, unknown>[] | string, path?: string, options?: IDeserializeOptions): T[]
deserializeAsync<T>(ctor: Constructor<T>, data: Record<string, unknown> | string, path?: string, options?: IDeserializeOptions): Promise<T>
deserializeArrayAsync<T>(...): Promise<T[]>
fromJSON<T>(ctor: Constructor<T>, json: string): T
fromJSONAsync<T>(ctor: Constructor<T>, json: string): Promise<T>

// Serialization
serialize<T extends object>(instance: T, path?: string, options?: ISerializeOptions): Record<string, unknown>
serializeArray<T extends object>(instances: T[], path?: string, options?: ISerializeOptions): Record<string, unknown>[]
serializeAsync<T extends object>(instance: T, path?: string, options?: ISerializeOptions): Promise<Record<string, unknown>>
serializeArrayAsync<T extends object>(...): Promise<Record<string, unknown>[]>
toJSON<T>(instance: T, space?: number): string
toJSONAsync<T>(instance: T, space?: number): Promise<string>

// Utilities
clone<T>(ctor: Constructor<T>, instance: T): T
patch<T>(ctor: Constructor<T>, instance: T, partial: Record<string, unknown>): T
isSerializable(ctor: Constructor): boolean
isEnum(obj: unknown): boolean
generateJSONSchema(ctor: Constructor, namingStrategy?: NamingStrategy): Record<string, unknown>
```

### Deserialization Options

When calling `deserialize()` or `deserializeArray()`, pass a fourth `options` argument:

```ts
interface IDeserializeOptions {
	/**
	 * When `true`, any JSON keys not declared via `@JSONProperty` cause
	 * a `SerializationError`. Useful for validating untrusted input.
	 * Defaults to `false`.
	 */
	strict?: boolean;

	/**
	 * Global key mapping strategy for JSON <-> property name conversion.
	 * Explicit `@JSONProperty({ name })` values always win.
	 */
	namingStrategy?: (propertyKey: string) => string;
	unknownProperties?: 'ignore' | 'error' | 'collect';
	unknownProperty?: string; // destination property for collect mode
}
```

Example:
```ts
const user = deserialize(User, data, '$', { strict: true });
```

### Serialization Options

```ts
interface ISerializeOptions {
	/**
	 * Global key mapping strategy for property -> JSON key conversion.
	 * Explicit `@JSONProperty({ name })` values always win.
	 */
	namingStrategy?: (propertyKey: string) => string;
	groups?: string[];
	includeSensitive?: boolean;
}
```

### Schema evolution and unknown fields

Aliases accept old names while serialization always emits the canonical name. Version migrations run in order; migration `N` upgrades version `N` to `N + 1`.

```ts
@Serializable()
@JSONVersion(2, {
	migrations: {
		0: data => ({ ...data, name: data.old_name }),
		1: data => ({ ...data, fullName: data.name }),
	},
})
class User {
	@JSONProperty({ aliases: ['name'], optional: false }) fullName!: string;
}

const value = deserialize(User, payload, '$', {
	unknownProperties: 'collect',
	unknownProperty: 'extensions',
});
```

Serialization emits the current `$version`. Configure another field with `JSONVersion(..., { field: 'version' })`.

### Codecs and projections

```ts
const epochCodec: JSONCodec<Date, number> = {
	serialize: date => date.getTime(),
	deserialize: value => new Date(value),
	schema: { type: 'integer' },
};

class Session {
	@JSONProperty({ codec: epochCodec }) createdAt!: Date;
	@JSONProperty({ groups: ['admin'], sensitive: true }) token!: string;
}

serialize(session, '$', { groups: ['admin'], includeSensitive: true });
```

`generateJSONSchema(Session)` produces draft 2020-12 JSON Schema, including nested definitions, enums, aliases, groups, nullability, collections, and codec schema fragments.

### Global Naming Strategies

You can globally format property keys into standardized JSON casing like `snake_case` or `PascalCase` without manually applying the `.name` attribute on every single property wrapper:

```ts
import { NamingStrategies } from '@depthbomb/serde';

@Serializable()
class User {
	@JSONProperty() firstName!: string;
	@JSONProperty() lastName!: string;
}

const payload = { first_name: 'John', last_name: 'Doe' };
const user = deserialize(User, payload, '$', {
	namingStrategy: NamingStrategies.camelToSnake
});

console.log(user.firstName); // "John"
```

> Note: Any property that explicitly declares `@JSONProperty({ name: 'CUSTOM' })` will bypass the NamingStrategy directly and preserve its intentional schema name.

---

## Recipes

### Nested classes

```ts
@Serializable()
class Address {
	@JSONProperty() street!: string;
	@JSONProperty() city!: string;
}

@Serializable()
class Person {
	@JSONProperty() name!: string;
	@JSONProperty({ type: () => Address }) address!: Address;
}

const person = deserialize(Person, {
	name: 'Grace',
	address: { street: '42 Broadway', city: 'New York' },
});
console.log(person.address instanceof Address); // true
```

### Arrays of classes

```ts
@Serializable()
class Order {
	@JSONProperty({ type: () => LineItem, isArray: true })
	items!: LineItem[];
}
```

### Maps

```ts
@Serializable()
class Catalog {
	// Serialized as a plain object { 'sku-1': {...}, ... }
	@JSONProperty({ type: () => Product, isMap: true })
	products!: Map<string, Product>;
}
```

### Sets

```ts
@Serializable()
class TagGroup {
	// Serialized as a plain array ["foo", "bar"]
	@JSONProperty({ type: String, isSet: true })
	tags!: Set<string>;
}
```

### Dates and URLs

JavaScript `Date` and `URL` objects are supported natively without custom transforms.

```ts
@Serializable()
class Event {
	@JSONProperty({ type: Date })
	startDate!: Date;

	@JSONProperty({ type: URL })
	link!: URL;
}

const ev = deserialize(Event, {
	startDate: '2026-03-20T11:23:46.000Z',
	link: 'https://example.com/foo'
});
console.log(ev.startDate.getFullYear()); // 2026
console.log(ev.link.pathname); // /foo
```

### Enums

```ts
enum Status {
	Active = 'ACTIVE',
	Inactive = 'INACTIVE'
}

enum Priority {
	Low = 0,
	Medium = 1,
	High = 2
}

@Serializable()
class Task {
	@JSONProperty()
	title!: string;

	@JSONProperty({ type: () => Status })
	status!: Status;

	@JSONProperty({ type: () => Priority })
	priority!: Priority;
}

const task = deserialize(Task, {
	title: 'Fix bug',
	status: 'ACTIVE',
	priority: 1
});

console.log(task.status);   // 'ACTIVE'
console.log(task.priority); // 1

const plain = serialize(task); // { title: 'Fix bug', status: 'ACTIVE', priority: 1 }
```

### Default values

```ts
@Serializable()
class Settings {
	@JSONProperty({ defaultValue: 'light' }) theme!: string;
	@JSONProperty({ defaultValue: () => [] }) tags!: string[]; // factory for safe mutable defaults
}
```

### Required properties

```ts
@Serializable()
class Config {
	@JSONProperty({ optional: false })
	apiKey!: string; // throws SerializationError if missing
}
```

### Validation

```ts
@Serializable()
class Product {
	@JSONProperty({ validate: (v: number) => v > 0 || 'Price must be positive' })
	price!: number;
}
```

### Null handling

```ts
@Serializable()
class Record {
	@JSONProperty({ nullable: 'null' }) mayBeNull!: string | null; // preserved
	@JSONProperty({ nullable: 'ignore' }) skipNull?: string;       // omitted (default)
	@JSONProperty({ nullable: 'error' }) mustExist!: string;       // throws
}
```

### Inheritance

```ts
@Serializable()
class Animal {
	@JSONProperty() name!: string;
}

@Serializable()
class Pet extends Animal {
	@JSONProperty() ownerName!: string;
	// `name` is inherited and still serialized
}
```

### Clone & patch

```ts
const copy    = clone(User, user);              // deep-independent copy
const updated = patch(User, user, { age: 37 }); // non-destructive update
```

---

## Error handling

All library, parser, migration, codec, transform, validation, and constructor failures are exposed as `SerializationError`. Native failures are preserved in `.cause`; `.path` uses JSONPath-style notation:

```ts
import { SerializationError } from '@depthbomb/serde';

try {
	deserialize(User, {});
} catch (err) {
	if (err instanceof SerializationError) {
		console.log(err.message); // [@depthbomb/serde] Missing required property '...' (at '$.fieldName')
		console.log(err.path);    // '$.fieldName'
	}
}
```
