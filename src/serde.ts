import { SerializationError } from './errors';

type AnyFn    = Constructor & Record<string, unknown>;
type PlainObj = Record<string, unknown>;

interface IPropertyMeta<V = unknown> {
	propertyKey: string;
	options: Required<IJSONPropertyOptions<V>>;
}

/** Any newable constructor */
export type Constructor<T = unknown> = new (...args: unknown[]) => T;

/** Lazy type reference, avoids circular-import issues */
export type TypeFn<T = unknown> = () => Constructor<T> | Record<string, string | number>;

/** TypeScript enum type */
export type EnumType = Record<string, string | number>;

/** What to do when a property value is null / undefined */
export type NullableStrategy = 'ignore' | 'null' | 'error';

/**
 * Deserialize a plain object (or JSON string) into a typed class instance.
 *
 * @example
 * const user = deserialize(User, { first_name: 'Leon', age: 36 });
 */
export interface IDeserializeOptions {
	/**
	 * When true, extra keys in the input object (not declared via @JSONProperty)
	 * will cause a SerializationError. Defaults to false.
	 */
	strict?: boolean;
}

export interface IJSONPropertyOptions<T = unknown> {
	/**
	 * JSON key name. Defaults to the property name.
	 * @example { name: "first_name" }
	 */
	name?: string;

	/**
	 * Explicit type constructor for nested objects, or an enum type.
	 * Use a thunk `() => MyClass` or `() => MyEnum` to support forward / circular references.
	 * @example { type: () => Address }
	 * @example { type: () => Status } // enum
	 */
	type?: TypeFn<T> | Constructor<T> | EnumType;

	/**
	 * Treat the property as an array of `type`.
	 * @example { type: () => Tag, isArray: true }
	 */
	isArray?: boolean;

	/**
	 * Treat the property as a Map<string, T>.
	 * Serialized as a plain object; deserialized as a native `Map`.
	 */
	isMap?: boolean;

	/**
	 * Allow the key to be absent in JSON input.
	 * Set to `false` to make the property required (throws if missing).
	 * @default true
	 */
	optional?: boolean;

	/**
	 * Behaviour when the raw value is `null`:
	 *  - `"ignore"` omit the assignment (default)
	 *  - `"null"`   assign null to the property
	 *  - `"error"`  throw a SerializationError
	 * @default "ignore"
	 */
	nullable?: NullableStrategy;

	/**
	 * Transform applied after deserialization: raw JSON value → typed value.
	 * @example (raw) => new Date(raw as string)
	 */
	deserializeTransform?: (raw: unknown) => T;

	/**
	 * Transform applied before serialization: typed value → raw JSON value.
	 * @example (d: Date) => d.toISOString()
	 */
	serializeTransform?: (value: T) => unknown;

	/**
	 * Default value used when the key is absent during deserialization.
	 * Use a factory function for mutable defaults (arrays, objects).
	 * @example { defaultValue: () => [] }
	 * @example { defaultValue: 42 }
	 */
	defaultValue?: T | (() => T);

	/**
	 * Validation function run after deserialization.
	 * Return `false` or a string message to signal failure (throws).
	 * @example (v: number) => v > 0 || "Must be positive"
	 */
	validate?: (value: T) => boolean | string | void;
}

// Ctor.__serde_s__  = true                     (@Serializable marker)
// Ctor.__serde_p__  = IPropertyMeta[]          (own, not inherited)
// Ctor.__serde_d__  = string                   (discriminator field)
// Ctor.__serde_t__  = Map<string, Constructor> (subtype registry)

const S = '__serde_s__';
const P = '__serde_p__';
const D = '__serde_d__';
const T = '__serde_t__';

const PRIMITIVES = new Set<unknown>([String, Number, Boolean, BigInt]);

/** Detect if a value is a TypeScript enum object. */
export function isEnum(obj: unknown): boolean {
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
		return false;
	}

	if (obj instanceof Map || obj instanceof Set || obj instanceof Date) {
		return false;
	}

	const keys = Object.keys(obj);
	if (keys.length < 2) {
		return false;
	}

	const objRecord = obj as Record<string, unknown>;

	for (const k of keys) {
		const v = objRecord[k];
		const isValidEnumValue = typeof v === 'string' || typeof v === 'number';
		if (!isValidEnumValue) {
			return false;
		}
	}

	// All properties are string or number primitives, and there are at least 2
	return true;
}

/** Get all valid values from an enum object */
function getEnumValues(enumObj: Record<string, string | number>): (string | number)[] {
	const values = new Set<string | number>();
	for (const v of Object.values(enumObj)) {
		if (typeof v === 'string' || typeof v === 'number') {
			values.add(v);
		}
	}

	return Array.from(values);
}

/** Collect all \@JSONProperty metas walking the prototype chain (child wins). */
const metasCache = new WeakMap<Constructor, IPropertyMeta[]>();

function ownMetas(ctor: AnyFn): IPropertyMeta[] {
	if (!Object.prototype.hasOwnProperty.call(ctor, P)) {
		Object.defineProperty(ctor, P, { value: [], writable: true, configurable: true, enumerable: false });
	}

	return ctor[P] as IPropertyMeta[];
}

function allMetas(ctor: Constructor): IPropertyMeta[] {
	const cached = metasCache.get(ctor);
	if (cached) {
		return cached;
	}

	const result = [] as IPropertyMeta[];
	const seen = new Set<string>();
	let proto: object | null = ctor;
	while (proto && proto !== Function.prototype && proto !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(proto, P)) {
			for (const m of (proto as AnyFn)[P] as IPropertyMeta[]) {
				if (!seen.has(m.propertyKey)) {
					seen.add(m.propertyKey);
					result.push(m);
				}
			}
		}

		proto = Object.getPrototypeOf(proto) as object | null;
	}

	metasCache.set(ctor, result);

	return result;
}

function isPrim(ctor: unknown): boolean { return PRIMITIVES.has(ctor); }

function coercePrim(value: unknown, ctor: Constructor, path: string): unknown {
	if (ctor === String) {
		return String(value);
	}

	if (ctor === Number) {
		const n = Number(value);
		if (Number.isNaN(n)) {
			throw new SerializationError(`Expected number, got "${value}"`, path);
		}

		return n;
	}

	if (ctor === Boolean) {
		return Boolean(value);
	}

	if ((ctor as unknown) === BigInt) {
		return (BigInt as unknown as (v: number) => bigint)(value as number);
	}

	return value;
}

/**
 * Resolve the concrete constructor from a type option that may be:
 *   - null / undefined → no explicit type
 *   - () => MyClass    → thunk (forward reference, can return constructor or enum)
 *   - MyClass          → direct constructor reference
 *   - EnumType         → enum object
 */
function resolveType<V>(options: Required<IJSONPropertyOptions<V>>): Constructor<V> | Record<string, string | number> | null {
	const t = options.type;
	if (!t) {
		return null;
	}

	const isArrow = typeof t === 'function' && !Object.prototype.hasOwnProperty.call(t, 'prototype');
	if (isArrow) {
		try {
			const result = (t as TypeFn<V>)();
			if (typeof result === 'function' || (typeof result === 'object' && result !== null)) {
				return result as any;
			}
		} catch { /* not a valid thunk */ }
	}

	return t as any;
}

function resolveDefault<V>(options: Required<IJSONPropertyOptions<V>>): V | undefined {
	if (options.defaultValue === undefined) {
		return undefined;
	}

	return typeof options.defaultValue === 'function'
		? (options.defaultValue as () => V)()
		: options.defaultValue;
}

/**
 * Mark a class as serializable.
 * Required for classes used as nested types.
 *
 * @example
 * \@Serializable()
 * class User { ... }
 */
export function Serializable(): ClassDecorator {
	return (target) => { (target as AnyFn)[S] = true; };
}

/** Returns `true` if the class was decorated with \@Serializable */
export function isSerializable(ctor: Constructor): boolean {
	return (ctor as AnyFn)[S] === true;
}

/**
 * Mark a property for (de)serialization.
 *
 * @example
 * \@JSONProperty({ name: "first_name" })
 * firstName!: string;
 *
 * \@JSONProperty({ type: () => Address })
 * address!: Address;
 *
 * \@JSONProperty({ type: () => Tag, isArray: true })
 * tags!: Tag[];
 *
 * \@JSONProperty({
 *   deserializeTransform: (raw) => new Date(raw as string),
 *   serializeTransform:   (d: Date) => d.toISOString(),
 * })
 * createdAt!: Date;
 */
export function JSONProperty<V = unknown>(options: IJSONPropertyOptions<V> = {}): PropertyDecorator {
	return (target, propertyKey) => {
		if (typeof propertyKey !== 'string') {
			throw new Error('@JSONProperty only supports string keys.');
		}

		const ctor  = target.constructor as AnyFn;
		const metas = ownMetas(ctor);
		const full = {
			name: options.name ?? propertyKey,
			type: (options.type ?? null) as Required<IJSONPropertyOptions<V>>['type'],
			isArray: options.isArray ?? false,
			isMap: options.isMap ?? false,
			optional: options.optional ?? true,
			nullable: options.nullable ?? 'ignore',
			deserializeTransform: options.deserializeTransform ?? ((v) => v as V),
			serializeTransform: options.serializeTransform ?? ((v) => v),
			defaultValue: (options.defaultValue ?? undefined) as V,
			validate: options.validate ?? (() => undefined),
		} as Required<IJSONPropertyOptions<V>>;

		const idx = metas.findIndex((m) => m.propertyKey === propertyKey);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const entry = { propertyKey, options: full as any };
		if (idx >= 0) {
			metas[idx] = entry;
		} else {
			metas.push(entry);
		}
	};
}

/**
 * Configure polymorphic deserialization on a base class.
 * The `field` value in incoming JSON selects the concrete subtype.
 *
 * @example
 * \@Serializable()
 * \@JSONDiscriminator("type")
 * \@JSONSubType("circle", Circle)
 * \@JSONSubType("rect",   Rectangle)
 * class Shape { ... }
 */
export function JSONDiscriminator(field: string): ClassDecorator {
	return (target) => { (target as AnyFn)[D] = field; };
}

/**
 * Register a concrete subtype for a \@JSONDiscriminator base class.
 */
export function JSONSubType<V>(value: string, ctor: Constructor<V>): ClassDecorator {
	return (target) => {
		const map = ((target as AnyFn)[T] as Map<string, Constructor>) ?? new Map<string, Constructor>();
		map.set(value, ctor);
		(target as AnyFn)[T] = map;
	};
}

export function deserialize<V>(ctor: Constructor<V>, data: PlainObj | string, _path = '$', options: IDeserializeOptions = {}): V {
	const raw = (typeof data === 'string' ? JSON.parse(data) : data) as PlainObj;
	if (raw === null || raw === undefined) {
		throw new SerializationError('Cannot deserialize null/undefined', _path);
	}

	const discField = (ctor as AnyFn)[D] as string | undefined;
	if (discField) {
		const discValue = raw[discField] as string;
		const subtypes = (ctor as AnyFn)[T] as Map<string, Constructor<V>> | undefined;
		if (subtypes && discValue !== undefined) {
			const sub = subtypes.get(discValue);
			if (!sub) {
				throw new SerializationError(`Unknown discriminator value "${discValue}" for field "${discField}"`, _path,);
			}

			// avoid recursion if the resolved subtype is the same constructor
			if (sub !== ctor) {
				return deserialize(sub, raw, _path);
			}
		}
	}

	const seenKeys = new Set<string>(); // track which keys we've assigned (for strict mode)
	const instance = new ctor();
	const metas    = allMetas(ctor);
	for (const meta of metas) {
		const { propertyKey, options } = meta;
		const jsonKey                  = options.name;
		const path                     = `${_path}.${jsonKey}`;
		const hasKey                   = Object.prototype.hasOwnProperty.call(raw, jsonKey);

		let rawValue: unknown = hasKey ? raw[jsonKey] : undefined;

		if (hasKey) {
			seenKeys.add(jsonKey);
		}

		if (rawValue === undefined) {
			const def = resolveDefault(options);
			if (def !== undefined) { (instance as PlainObj)[propertyKey] = def; continue; }
			if (!options.optional) throw new SerializationError(`Missing required property "${jsonKey}"`, path);
			continue;
		}

		if (rawValue === null) {
			if (options.nullable === 'error') {
				throw new SerializationError(`Property "${jsonKey}" must not be null`, path);
			}

			if (options.nullable === 'null') {
				(instance as PlainObj)[propertyKey] = null;
			}

			continue;
		}

		const NestedCtor = resolveType(options);

		if (options.isMap) {
			if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
				throw new SerializationError(`Expected object for map property "${jsonKey}"`, path);
			}

			const map = new Map<string, unknown>();
			for (const [k, v] of Object.entries(rawValue as PlainObj)) {
				if (NestedCtor) {
					if (isEnum(NestedCtor)) {
						const validValues = getEnumValues(NestedCtor as Record<string, string | number>);
						if (!validValues.includes(v as string | number)) {
							throw new SerializationError(`Expected one of [${validValues.join(', ')}], got "${v}"`, `${path}["${k}"]`);
						}

						map.set(k, v);
					} else if (isPrim(NestedCtor as Constructor)) {
						map.set(k, coercePrim(v, NestedCtor as Constructor, `${path}["${k}"]`));
					} else {
						map.set(k, v !== null && typeof v === 'object' ? deserialize(NestedCtor as Constructor, v as PlainObj, `${path}["${k}"]`) : v);
					}
				} else {
					map.set(k, v);
				}
			}

			(instance as PlainObj)[propertyKey] = map;
			continue;
		}

		if (options.isArray) {
			if (!Array.isArray(rawValue)) {
				throw new SerializationError(`Expected array for property "${jsonKey}"`, path);
			}

			rawValue = (rawValue as unknown[]).map((item, i) => {
				if (item === null || item === undefined) {
					return item;
				}

				if (NestedCtor) {
					if (isEnum(NestedCtor)) {
						const validValues = getEnumValues(NestedCtor as Record<string, string | number>);
						if (!validValues.includes(item as string | number)) {
							throw new SerializationError(`Expected one of [${validValues.join(', ')}], got "${item}"`, `${path}[${i}]`);
						}

						return item;
					} else if (isPrim(NestedCtor as Constructor)) {
						return coercePrim(item, NestedCtor as Constructor, `${path}[${i}]`);
					} else {
						return deserialize(NestedCtor as Constructor, item as PlainObj, `${path}[${i}]`);
					}
				}

				return item;
			});
		} else if (NestedCtor) {
			if (isEnum(NestedCtor)) {
				const validValues = getEnumValues(NestedCtor as Record<string, string | number>);
				if (!validValues.includes(rawValue as string | number)) {
					throw new SerializationError(`Expected one of [${validValues.join(', ')}], got "${rawValue}"`, path);
				}
			} else if (isPrim(NestedCtor as Constructor)) {
				rawValue = coercePrim(rawValue, NestedCtor as Constructor, path);
			} else {
				if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
					throw new SerializationError(`Expected object for nested type "${(NestedCtor as Constructor).name}" at "${jsonKey}"`, path);
				}

				rawValue = deserialize(NestedCtor as Constructor, rawValue as PlainObj, path);
			}
		}

		rawValue = options.deserializeTransform(rawValue);

		const vResult = options.validate(rawValue as V);
		if (vResult === false || typeof vResult === 'string') {
			throw new SerializationError(typeof vResult === 'string' ? vResult : `Validation failed for property "${jsonKey}"`, path);
		}

		(instance as PlainObj)[propertyKey] = rawValue;
	}

	if (options.strict) {
		for (const k of Object.keys(raw)) {
			if (!seenKeys.has(k)) {
				throw new SerializationError(`Unexpected property "${k}"`, _path);
			}
		}
	}
	return instance;
}

/**
 * Deserialize a JSON array into a typed class instance array.
 *
 * @example
 * const users = deserializeArray(User, '[{"first_name":"Ada",...}]');
 */
export function deserializeArray<V>(ctor: Constructor<V>, data: PlainObj[] | string, path = '$', options: IDeserializeOptions = {}): V[] {
	const raw = typeof data === 'string' ? (JSON.parse(data) as PlainObj[]) : data;
	if (!Array.isArray(raw)) {
		throw new SerializationError('Expected an array at root', path);
	}

	return raw.map((item, i) => deserialize(ctor, item, `${path}[${i}]`, options));
}

/**
 * Serialize a class instance to a plain JSON-compatible object.
 *
 * @example
 * const plain = serialize(user); // { first_name: "Ada", age: 36 }
 */
export function serialize<V extends object>(instance: V, _path = '$'): PlainObj {
	if (instance === null || instance === undefined) {
		throw new SerializationError('Cannot serialize null/undefined', _path);
	}

	const ctor = instance.constructor as Constructor<V>;
	if (!isSerializable(ctor)) {
		throw new SerializationError(`Cannot serialize instance of unmarked class "${ctor.name || 'Object'}"`, _path);
	}

	const metas  = allMetas(ctor);
	const result = {} as PlainObj;

	for (const meta of metas) {
		const { propertyKey, options } = meta;
		const jsonKey                  = options.name;
		const path                     = `${_path}.${jsonKey}`;

		let value: unknown = (instance as PlainObj)[propertyKey];

		value = options.serializeTransform(value as never) as unknown;
		if (value === null || value === undefined) {
			if (options.nullable === 'error') {
				throw new SerializationError(`Property "${propertyKey}" must not be null/undefined`, path);
			}

			if (options.nullable === 'null') {
				result[jsonKey] = null;
			}
			continue;
		}

		if (options.isMap && value instanceof Map) {
			const obj = {} as PlainObj;
			for (const [k, v] of (value as Map<string, unknown>)) {
				obj[k] = v !== null && typeof v === 'object' ? serialize(v as object, `${path}["${k}"]`) : v;
			}

			result[jsonKey] = obj;
			continue;
		}

		if (Array.isArray(value)) {
			result[jsonKey] = (value as unknown[]).map((item, i) =>
				item !== null && typeof item === 'object'
					? serialize(item as object, `${path}[${i}]`)
					: item,
			);
			continue;
		}

		if (typeof value === 'object') {
			result[jsonKey] = serialize(value as object, path);
			continue;
		}

		result[jsonKey] = value;
	}

	return result;
}

/**
 * Serialize an array of class instances to a plain object array.
 */
export function serializeArray<V extends object>(instances: V[], path = '$'): PlainObj[] {
	return instances.map((inst, i) => serialize(inst, `${path}[${i}]`));
}

/**
 * Serialize a class instance to a JSON string.
 * @param space Passed to JSON.stringify for pretty-printing.
 */
export function toJSON<V extends object>(instance: V, space?: number): string {
	return JSON.stringify(serialize(instance), null, space);
}

/**
 * Deserialize a JSON string to a class instance.
 */
export function fromJSON<V>(ctor: Constructor<V>, json: string): V {
	return deserialize(ctor, json);
}

/**
 * Deep-clone a serializable instance by round-tripping through serialization.
 * Guarantees a fully independent copy with no shared references.
 *
 * @example
 * const copy = clone(User, user);
 */
export function clone<V extends object>(ctor: Constructor<V>, instance: V): V {
	return deserialize(ctor, serialize(instance));
}

/**
 * Merge a partial plain-object patch into an existing instance.
 * Keys present in `partial` override the current values; everything else is preserved.
 *
 * @example
 * const updated = patch(User, user, { age: 37 });
 */
export function patch<V extends object>(ctor: Constructor<V>, instance: V, partial: Partial<PlainObj>): V {
	return deserialize(ctor, { ...serialize(instance), ...partial });
}
