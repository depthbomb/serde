# @depthbomb/serde

Type-safe JSON ↔ Class serialization for TypeScript

---

## Installation

```sh
yarn install @depthbomb/serde
bun add @depthbomb/serde
npm install @depthbomb/serde
```

Enable TypeScript decorators in `tsconfig.json`:

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
| `type` | `Constructor \| () => Constructor` | — | Nested class type (use thunk for forward refs) |
| `isArray` | `boolean` | `false` | Property holds `T[]` |
| `isMap` | `boolean` | `false` | Property holds `Map<string, T>` |
| `optional` | `boolean` | `true` | Skip if key absent; `false` = required |
| `nullable` | `'ignore' \| 'null' \| 'error'` | `'ignore'` | Behaviour when value is `null` |
| `defaultValue` | `T \| (() => T)` | — | Default when key is absent |
| `deserializeTransform` | `(raw: unknown) => T` | identity | Post-deserialization transform |
| `serializeTransform` | `(value: T) => unknown` | identity | Pre-serialization transform |
| `validate` | `(value: T) => boolean \| string \| void` | — | Validator; `false`/string throws |

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
deserialize<T>(ctor: Constructor<T>, data: object | string, path?: string, options?: IDeserializeOptions): T
deserializeArray<T>(ctor: Constructor<T>, data: object[] | string, path?: string, options?: IDeserializeOptions): T[]
fromJSON<T>(ctor: Constructor<T>, json: string): T

// Serialization
serialize<T>(instance: T, path?: string): Record<string, unknown>
serializeArray<T>(instances: T[]): Record<string, unknown>[]
toJSON<T>(instance: T, space?: number): string

// Utilities
clone<T>(ctor: Constructor<T>, instance: T): T
patch<T>(ctor: Constructor<T>, instance: T, partial: object): T
isSerializable(ctor: Constructor): boolean
isEnum(obj: unknown): boolean
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
}
```

Example:
```ts
const user = deserialize(User, data, '$', { strict: true });
```

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

### Date transforms

```ts
@Serializable()
class Event {
	@JSONProperty({
		deserializeTransform: (raw) => new Date(raw as string),
		serializeTransform: (d: Date) => d.toISOString(),
	})
	startDate!: Date;
}
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

// Deserialize
const task = deserialize(Task, {
	title: 'Fix bug',
	status: 'ACTIVE',
	priority: 1
});
console.log(task.status);   // 'ACTIVE'
console.log(task.priority); // 1

// Serialize
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

All errors are instances of `SerializationError` with a `.path` property (JSON pointer style):

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
