import { SerializationError, SerializationErrorCode } from './errors';

type AnyFn    = Constructor & Record<string, unknown>;
type PlainObj = Record<string, unknown>;
type AnyEnum  = Record<string, string | number>;

interface IPropertyMeta<V = unknown> {
	propertyKey: string;
	options: Required<IJSONPropertyOptions<V>>;
	explicitName: boolean;
}

/** Any newable constructor */
export type Constructor<T = unknown> = new (...args: unknown[]) => T;

/** Lazy type reference, avoids circular-import issues */
export type TypeFn<T = unknown> = () => Constructor<T> | Record<string, string | number>;

/** TypeScript enum type */
export type EnumType = Record<string, string | number>;

/** What to do when a property value is null / undefined */
export type NullableStrategy = 'ignore' | 'null' | 'error';

export type NamingStrategy = (propertyKey: string) => string;

export const NamingStrategies = {
	camelToSnake: (key: string): string => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
	camelToPascal: (key: string): string => key.charAt(0).toUpperCase() + key.slice(1),
};

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

	/**
	 * Naming strategy applied to transform property keys mapping to JSON keys,
	 * unless explicitly overridden per-property via `@JSONProperty({ name })`.
	 */
	namingStrategy?: NamingStrategy;
}

export interface ISerializeOptions {
	/**
	 * Naming strategy applied to transform property keys mapping to JSON keys,
	 * unless explicitly overridden per-property via `@JSONProperty({ name })`.
	 */
	namingStrategy?: NamingStrategy;
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
	 * Treat the property as a Set<T>.
	 * Serialized as a plain array; deserialized as a native `Set`.
	 */
	isSet?: boolean;
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

const enumValueCache    = new WeakMap<EnumType, (string | number)[]>();
const enumValueSetCache = new WeakMap<EnumType, Set<string | number>>();
const enumCache         = new WeakSet<EnumType>();

/** Detect if a value is a TypeScript enum object. */
export function isEnum(obj: unknown): boolean {
	if (enumCache.has(obj as EnumType)) {
		return true;
	}

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
	enumCache.add(obj as EnumType);

	return true;
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

function isPrim(ctor: unknown): boolean {
	return ctor === String || ctor === Number || ctor === Boolean || (ctor as any) === BigInt || ctor === Date || ctor === URL;
}

function coercePrim(value: unknown, ctor: Constructor, path: string | (() => string)): unknown {
	if (ctor === String) {
		return String(value);
	}

	if (ctor === Number) {
		const n = Number(value);
		if (Number.isNaN(n)) {
			throw new SerializationError(`Expected number, got "${value}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH);
		}

		return n;
	}

	if (ctor === Boolean) {
		if (typeof value === 'boolean') {
			return value;
		}
		if (typeof value === 'string') {
			const normalized = value.trim().toLowerCase();
			if (normalized === 'true') {
				return true;
			}
			if (normalized === 'false') {
				return false;
			}
		}
		if (typeof value === 'number') {
			if (value === 1) {
				return true;
			}
			if (value === 0) {
				return false;
			}
		}
		throw new SerializationError(`Expected boolean, got "${value}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH);
	}

	if ((ctor as any) === BigInt) {
		return (BigInt as any)(value);
	}

	if (ctor === Date) {
		const d = new Date(value as any);
		if (Number.isNaN(d.getTime())) {
			throw new SerializationError(`Expected valid date string/number, got "${value}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH);
		}

		return d;
	}

	if (ctor === URL) {
		try {
			return new URL(String(value));
		} catch {
			throw new SerializationError(`Expected valid URL string, got "${value}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH);
		}
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
function resolveType<V>(options: Required<IJSONPropertyOptions<V>>): Constructor<V> | AnyEnum | null {
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

/** @internal */
export function __test_enumIsCached(enumObj: EnumType): boolean {
	return enumCache.has(enumObj);
}

/** @internal */
export function __test_cachedValues(enumObj: EnumType): (string | number)[] | undefined {
	return enumValueCache.get(enumObj);
}

/** @internal */
export function __test_cachedValueSet(enumObj: EnumType): Set<string | number> | undefined {
	return enumValueSetCache.get(enumObj);
}

/** Get all valid values from an enum object */
export function getEnumValues(enumObj: Record<string, string | number>): (string | number)[] {
	const cached = enumValueCache.get(enumObj as EnumType);
	if (cached) {
		return cached;
	}

	const values = new Set<string | number>();
	for (const [k, v] of Object.entries(enumObj)) {
		if (typeof v === 'string' && /^\d+$/.test(k) && enumObj[v] === Number(k)) {
			continue;
		}
		if (typeof v === 'string' || typeof v === 'number') {
			values.add(v);
		}
	}

	const arr = Array.from(values);
	enumValueCache.set(enumObj as EnumType, arr);
	enumValueSetCache.set(enumObj as EnumType, values);
	return arr;
}

/** Get a cached enum value set for O(1) membership checks */
function getEnumValueSet(enumObj: Record<string, string | number>): Set<string | number> {
	const cached = enumValueSetCache.get(enumObj as EnumType);
	if (cached) {
		return cached;
	}
	// Populates both array and set caches.
	getEnumValues(enumObj);
	return enumValueSetCache.get(enumObj as EnumType) as Set<string | number>;
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
export function JSONProperty<V = unknown>(options: IJSONPropertyOptions<V> = {}): (target: any, propertyKey?: any) => void {
	return (target, propertyKey) => {
		const key = typeof propertyKey === 'string' ? propertyKey : (propertyKey as any)?.name;
		if (typeof key !== 'string') {
			throw new Error('@JSONProperty only supports string keys.');
		}

		const ctor = target.constructor as AnyFn;
		const metas = ownMetas(ctor);
		const full = {
			name: options.name ?? key,
			type: (options.type ?? null) as Required<IJSONPropertyOptions<V>>['type'],
			isArray: options.isArray ?? false,
			isMap: options.isMap ?? false,
			isSet: options.isSet ?? false,
			optional: options.optional ?? true,
			nullable: options.nullable ?? 'ignore',
			deserializeTransform: options.deserializeTransform ?? ((v) => v as V),
			serializeTransform: options.serializeTransform ?? ((v) => v),
			defaultValue: (options.defaultValue ?? undefined) as V,
			validate: options.validate ?? (() => undefined),
		} as Required<IJSONPropertyOptions<V>>;

		const idx = metas.findIndex((m) => m.propertyKey === key);
		const entry: IPropertyMeta<V> = {
			propertyKey: key,
			options: full,
			explicitName: options.name !== undefined
		};
		if (idx >= 0) {
			metas[idx] = entry as IPropertyMeta<unknown>;
		} else {
			metas.push(entry as IPropertyMeta<unknown>);
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
		throw new SerializationError('Cannot deserialize null/undefined', _path, SerializationErrorCode.NULL_INPUT);
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new SerializationError('Expected plain object at root', _path, SerializationErrorCode.TYPE_MISMATCH);
	}
	const rawProto = Object.getPrototypeOf(raw);
	if (rawProto !== Object.prototype && rawProto !== null) {
		throw new SerializationError('Expected plain object at root', _path, SerializationErrorCode.TYPE_MISMATCH);
	}

	const discField = (ctor as AnyFn)[D] as string | undefined;
	if (discField) {
		const discValue = raw[discField] as string;
		const subtypes = (ctor as AnyFn)[T] as Map<string, Constructor<V>> | undefined;
		if (subtypes && discValue !== undefined) {
			const sub = subtypes.get(discValue);
			if (!sub) {
				throw new SerializationError(`Unknown discriminator value "${discValue}" for field "${discField}"`, _path, SerializationErrorCode.UNKNOWN_DISCRIMINATOR);
			}

			// avoid recursion if the resolved subtype is the same constructor
			if (sub !== ctor) {
				return deserialize(sub, raw, _path, options);
			}
		}
	}

	function convertValue(val: unknown, ctorOrEnum: Constructor | Record<string, string | number> | null, path: string | (() => string)): unknown {
		if (val === null || val === undefined) {
			return val;
		}

		if (!ctorOrEnum) {
			return val;
		}

		if (isEnum(ctorOrEnum)) {
			const validValueSet = getEnumValueSet(ctorOrEnum as AnyEnum);
			if (!validValueSet.has(val as string | number)) {
				const validValues = getEnumValues(ctorOrEnum as AnyEnum);
				throw new SerializationError(`Expected one of [${validValues.join(', ')}], got "${val}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.INVALID_ENUM_VALUE);
			}

			return val;
		}

		if (isPrim(ctorOrEnum as Constructor)) {
			return coercePrim(val, ctorOrEnum as Constructor, path);
		}

		// at this point we expect an object that will be recursively deserialized
		if (typeof val !== 'object' || Array.isArray(val)) {
			throw new SerializationError(`Expected object for nested type "${(ctorOrEnum as Constructor).name || 'Object'}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH);
		}

		return deserialize(ctorOrEnum as Constructor, val as PlainObj, typeof path === 'function' ? path() : path, options);
	}

	const seenKeys = new Set<string>(); // track which keys we've assigned (for strict mode)
	const instance = new ctor();
	const metas = allMetas(ctor);
	for (const meta of metas) {
		const { propertyKey, options: metaOptions, explicitName } = meta;
		const jsonKey = explicitName ? metaOptions.name : (options.namingStrategy ? options.namingStrategy(propertyKey) : metaOptions.name);
		const getPath = () => `${_path}.${jsonKey}`;
		const hasKey = Object.prototype.hasOwnProperty.call(raw, jsonKey);

		let rawValue: unknown = hasKey ? raw[jsonKey] : undefined;

		if (hasKey) {
			seenKeys.add(jsonKey);
		}

		if (rawValue === undefined) {
			const def = resolveDefault(metaOptions);
			if (def !== undefined) {
				(instance as PlainObj)[propertyKey] = def;
				continue;
			}

			if (!metaOptions.optional) {
				throw new SerializationError(`Missing required property "${jsonKey}"`, getPath(), SerializationErrorCode.MISSING_PROPERTY);
			}
			continue;
		}

		if (rawValue === null) {
			if (metaOptions.nullable === 'error') {
				throw new SerializationError(`Property "${jsonKey}" must not be null`, getPath(), SerializationErrorCode.NULL_NOT_ALLOWED);
			}

			if (metaOptions.nullable === 'null') {
				(instance as PlainObj)[propertyKey] = null;
			}
			continue;
		}

		const NestedCtor = resolveType(metaOptions);

		if (metaOptions.isMap) {
			if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
				throw new SerializationError(`Expected object for map property "${jsonKey}"`, getPath(), SerializationErrorCode.TYPE_MISMATCH);
			}

			const map = new Map<string, unknown>();
			for (const [k, v] of Object.entries(rawValue as PlainObj)) {
				// convertValue handles null/undefined, enum validation, and recursion
				map.set(k, convertValue(v, NestedCtor, () => `${getPath()}["${k}"]`));
			}

			(instance as PlainObj)[propertyKey] = map;
			continue;
		}

		if (metaOptions.isSet) {
			if (!Array.isArray(rawValue)) {
				throw new SerializationError(`Expected array for set property "${jsonKey}"`, getPath(), SerializationErrorCode.NOT_AN_ARRAY);
			}

			const set = new Set<unknown>();
			for (let i = 0; i < rawValue.length; i++) {
				set.add(convertValue(rawValue[i], NestedCtor, () => `${getPath()}[${i}]`));
			}

			(instance as PlainObj)[propertyKey] = set;
			continue;
		}

		if (metaOptions.isArray) {
			if (!Array.isArray(rawValue)) {
				throw new SerializationError(`Expected array for property "${jsonKey}"`, getPath(), SerializationErrorCode.NOT_AN_ARRAY);
			}

			rawValue = (rawValue as unknown[]).map((item, i) =>
				// convertValue handles null/undefined, enum validation, and recursion
				convertValue(item, NestedCtor, () => `${getPath()}[${i}]`),
			);
		} else {
			// convertValue handles null/undefined, enum validation, and recursion
			rawValue = convertValue(rawValue, NestedCtor, getPath);
		}

		rawValue = metaOptions.deserializeTransform(rawValue);

		const vResult = metaOptions.validate(rawValue as V);
		if (vResult === false || typeof vResult === 'string') {
			throw new SerializationError(typeof vResult === 'string' ? vResult : `Validation failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.VALIDATION_FAILED);
		}

		(instance as PlainObj)[propertyKey] = rawValue;
	}

	if (options.strict) {
		for (const k of Object.keys(raw)) {
			if (!seenKeys.has(k)) {
				throw new SerializationError(`Unexpected property "${k}" in strict mode`, _path, SerializationErrorCode.UNEXPECTED_PROPERTY);
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
		throw new SerializationError('Expected an array at root', path, SerializationErrorCode.NOT_AN_ARRAY);
	}

	return raw.map((item, i) => deserialize(ctor, item, `${path}[${i}]`, options));
}

/**
 * Serialize a class instance to a plain JSON-compatible object.
 *
 * @example
 * const plain = serialize(user); // { first_name: "Ada", age: 36 }
 */
export function serialize<V extends object>(instance: V, _path = '$', options: ISerializeOptions = {}): PlainObj {
	if (instance === null || instance === undefined) {
		throw new SerializationError('Cannot serialize null/undefined', _path, SerializationErrorCode.NULL_INPUT);
	}

	const ctor = instance.constructor as Constructor<V>;
	if (!isSerializable(ctor)) {
		throw new SerializationError(`Cannot serialize instance of unmarked class "${ctor.name || 'Object'}"`, _path, SerializationErrorCode.UNMARKED_CLASS);
	}

	// only properties decorated with @JSONProperty are included
	const result = {} as PlainObj;
	const metas  = allMetas(ctor);
	const setObjectKey = (obj: PlainObj, key: string, value: unknown): void => {
		if (key === '__proto__') {
			Object.defineProperty(obj, key, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			return;
		}
		obj[key] = value;
	};
	for (const meta of metas) {
		const { propertyKey, options: metaOptions, explicitName } = meta;
		const jsonKey = explicitName ? metaOptions.name : (options.namingStrategy ? options.namingStrategy(propertyKey) : metaOptions.name);
		const getPath = () => `${_path}.${jsonKey}`;

		let value: unknown = (instance as PlainObj)[propertyKey];
		if (value !== undefined && value !== null) {
			value = metaOptions.serializeTransform(value as never) as unknown;
		}

		if (value === null || value === undefined) {
			if (metaOptions.nullable === 'error') {
				throw new SerializationError(`Property "${propertyKey}" must not be null/undefined`, getPath(), SerializationErrorCode.NULL_NOT_ALLOWED);
			}

			if (metaOptions.nullable === 'null') {
				setObjectKey(result, jsonKey, null);
			}
			continue;
		}

		function serializeValue(v: unknown, pathGetter: () => string): unknown {
			if (v === null || v === undefined) {
				return v;
			}

			if (v instanceof Date) {
				return v.toISOString();
			}

			if (v instanceof URL) {
				return v.toString();
			}

			if (typeof v === 'object') {
				return serialize(v as object, pathGetter(), options);
			}

			return v;
		}

		if (metaOptions.isMap && value instanceof Map) {
			const obj = Object.create(null) as PlainObj;
			for (const [k, v] of (value as Map<string, unknown>)) {
				setObjectKey(obj, k, serializeValue(v, () => `${getPath()}["${k}"]`));
			}

			setObjectKey(result, jsonKey, obj);
			continue;
		}

		if (metaOptions.isSet && value instanceof Set) {
			setObjectKey(result, jsonKey, Array.from(value as Set<unknown>).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`)
			));
			continue;
		}

		if (Array.isArray(value)) {
			setObjectKey(result, jsonKey, (value as unknown[]).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`)
			));
			continue;
		}

		setObjectKey(result, jsonKey, serializeValue(value, getPath));
	}

	return result;
}

/**
 * Serialize an array of class instances to a plain object array.
 */
export function serializeArray<V extends object>(instances: V[], path = '$', options: ISerializeOptions = {}): PlainObj[] {
	if (!Array.isArray(instances)) {
		throw new SerializationError('Expected an array', path, SerializationErrorCode.NOT_AN_ARRAY);
	}

	return instances.map((inst, i) => serialize(inst, `${path}[${i}]`, options));
}
