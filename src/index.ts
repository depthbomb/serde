import { SerializationError, SerializationErrorCode } from './errors';

type AnyFn    = Constructor & Record<PropertyKey, unknown>;
type PlainObj = Record<string, unknown>;
type AnyEnum  = Record<string, string | number>;

interface IPropertyMeta<V = unknown> {
	propertyKey: string;
	options: Required<IJSONPropertyOptions<V>>;
	explicitName: boolean;
}

/** Any newable constructor */
export type Constructor<T = unknown> = new (...args: any[]) => T;

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
	groups?: string[];
	includeSensitive?: boolean;
}

export interface JSONCodec<T = unknown, Wire = unknown> {
	serialize(value: T): Wire;
	deserialize(value: Wire): T;
	schema?: Readonly<Record<string, unknown>>;
}

export interface IJSONPropertyOptions<T = unknown> {
	/**
	 * JSON key name. Defaults to the property name.
	 * @example { name: "first_name" }
	 */
	name?: string;
	aliases?: string[];
	/**
	 * Explicit type constructor for nested objects, or an enum type.
	 * Use a thunk `() => MyClass` or `() => MyEnum` to support forward / circular references.
	 * @example { type: () => Address }
	 * @example { type: () => Status } // enum
	 */
	type?: TypeFn<T> | Constructor<T> | EnumType;
	codec?: JSONCodec<T>;
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
	groups?: string[];
	sensitive?: boolean;
}

const S = Symbol('serde.serializable');
const P = Symbol('serde.properties');
const D = Symbol('serde.discriminator');
const T = Symbol('serde.subtypes');
const F = Symbol('serde.fallback');
const metaVersions = new WeakMap<Constructor, number>();

const enumValueCache    = new WeakMap<EnumType, (string | number)[]>();
const enumValueSetCache = new WeakMap<EnumType, Set<string | number>>();
const enumCache         = new WeakSet<EnumType>();

function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function parseJSON(value: string, path: string): unknown {
	try {
		return JSON.parse(value);
	} catch (cause) {
		throw new SerializationError('Invalid JSON input', path, SerializationErrorCode.INVALID_JSON, cause);
	}
}

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
interface IMetaCacheEntry {
	owners: AnyFn[];
	versions: number[];
	result: IPropertyMeta[];
}

const metasCache = new WeakMap<Constructor, IMetaCacheEntry>();

function ownMetas(ctor: AnyFn): IPropertyMeta[] {
	if (!Object.prototype.hasOwnProperty.call(ctor, P)) {
		Object.defineProperty(ctor, P, { value: [], writable: true, configurable: true, enumerable: false });
	}

	return ctor[P] as IPropertyMeta[];
}

function allMetas(ctor: Constructor): IPropertyMeta[] {
	const owners: AnyFn[] = [];
	let owner: object | null = ctor;
	while (owner && owner !== Function.prototype && owner !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(owner, P)) {
			owners.push(owner as AnyFn);
		}
		owner = Object.getPrototypeOf(owner) as object | null;
	}

	const cached = metasCache.get(ctor);
	if (cached && cached.owners.length === owners.length && cached.owners.every((item, index) =>
		item === owners[index] && cached.versions[index] === (metaVersions.get(item) ?? 0)
	)) {
		return cached.result;
	}

	const result = [] as IPropertyMeta[];
	const seen = new Set<string>();
	for (const proto of owners) {
			for (const m of proto[P] as IPropertyMeta[]) {
				if (!seen.has(m.propertyKey)) {
					seen.add(m.propertyKey);
					result.push(m);
				}
			}
	}

	metasCache.set(ctor, {
		owners,
		versions: owners.map(item => metaVersions.get(item) ?? 0),
		result,
	});

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
		try {
			return (BigInt as any)(value);
		} catch (cause) {
			throw new SerializationError(`Expected valid BigInt value, got "${value}"`, typeof path === 'function' ? path() : path, SerializationErrorCode.TYPE_MISMATCH, cause);
		}
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

function resolveDefault<V>(options: Required<IJSONPropertyOptions<V>>, path: string): V | undefined {
	if (options.defaultValue === undefined) {
		return undefined;
	}

	try {
		return typeof options.defaultValue === 'function'
			? (options.defaultValue as () => V)()
			: options.defaultValue;
	} catch (cause) {
		throw new SerializationError('Default value factory failed', path, SerializationErrorCode.TRANSFORM_FAILED, cause);
	}
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

	const arr = Object.freeze(Array.from(values)) as (string | number)[];
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
	const collectionKinds = [options.isArray, options.isMap, options.isSet].filter(Boolean).length;
	if (collectionKinds > 1) {
		throw new Error('@JSONProperty only supports one of isArray, isMap, or isSet.');
	}
	if (options.codec && options.type) {
		throw new Error('@JSONProperty codec and type options are mutually exclusive.');
	}

	return (target, propertyKey) => {
		const key = typeof propertyKey === 'string' ? propertyKey : (propertyKey as any)?.name;
		if (typeof key !== 'string') {
			throw new Error('@JSONProperty only supports string keys.');
		}

		const ctor = target.constructor as AnyFn;
		const metas = ownMetas(ctor);
		const full = {
			name: options.name ?? key,
			aliases: options.aliases ?? [],
			type: (options.type ?? null) as Required<IJSONPropertyOptions<V>>['type'],
			codec: (options.codec ?? null) as Required<IJSONPropertyOptions<V>>['codec'],
			isArray: options.isArray ?? false,
			isMap: options.isMap ?? false,
			isSet: options.isSet ?? false,
			optional: options.optional ?? true,
			nullable: options.nullable ?? 'ignore',
			deserializeTransform: options.deserializeTransform ?? ((v) => v as V),
			serializeTransform: options.serializeTransform ?? ((v) => v),
			defaultValue: (options.defaultValue ?? undefined) as V,
			validate: options.validate ?? (() => undefined),
			groups: options.groups ?? [],
			sensitive: options.sensitive ?? false,
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
		metaVersions.set(ctor, (metaVersions.get(ctor) ?? 0) + 1);
	};
}

/** Read-only property-to-JSON mappings for a serializable class. */
export function getJSONProperties(ctor: Constructor, namingStrategy?: NamingStrategy): ReadonlyArray<Readonly<{ propertyKey: string; jsonKey: string }>> {
	return allMetas(ctor).map(({ propertyKey, options, explicitName }) => Object.freeze({
		propertyKey,
		jsonKey: explicitName ? options.name : (namingStrategy ? namingStrategy(propertyKey) : options.name),
	}));
}

/** Generate a JSON Schema (draft 2020-12) from serializer metadata. */
export function generateJSONSchema(ctor: Constructor, namingStrategy?: NamingStrategy): Record<string, unknown> {
	const definitions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	const building = new Set<Constructor>();

	const valueSchema = (meta: IPropertyMeta): Record<string, unknown> => {
		if (meta.options.codec?.schema) {
			return { ...meta.options.codec.schema };
		}
		const type = resolveType(meta.options);
		if (!type) return {};
		if (typeof type === 'object' || isEnum(type)) return { enum: getEnumValues(type as AnyEnum) };
		if (type === String) return { type: 'string' };
		if (type === Number) return { type: 'number' };
		if (type === Boolean) return { type: 'boolean' };
		if ((type as unknown) === BigInt) return { type: 'string', pattern: '^-?\\d+$' };
		if (type === Date) return { type: 'string', format: 'date-time' };
		if (type === URL) return { type: 'string', format: 'uri' };
		buildDefinition(type as Constructor);
		return { $ref: `#/$defs/${(type as Constructor).name || 'Anonymous'}` };
	};

	const buildDefinition = (target: Constructor): Record<string, unknown> => {
		const name = target.name || 'Anonymous';
		if (definitions[name]) return definitions[name] as Record<string, unknown>;
		if (building.has(target)) return { $ref: `#/$defs/${name}` };
		building.add(target);
		const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const required: string[] = [];
		for (const meta of allMetas(target)) {
			const jsonKey = meta.explicitName ? meta.options.name : (namingStrategy ? namingStrategy(meta.propertyKey) : meta.options.name);
			let schema = valueSchema(meta);
			if (meta.options.isArray || meta.options.isSet) {
				schema = { type: 'array', items: schema, ...(meta.options.isSet ? { uniqueItems: true } : {}) };
			} else if (meta.options.isMap) {
				schema = { type: 'object', additionalProperties: schema };
			}
			if (meta.options.nullable === 'null') schema = { anyOf: [schema, { type: 'null' }] };
			if (meta.options.aliases.length) schema['x-aliases'] = [...meta.options.aliases];
			if (meta.options.groups.length) schema['x-groups'] = [...meta.options.groups];
			if (meta.options.sensitive) schema.writeOnly = true;
			properties[jsonKey] = schema;
			if (!meta.options.optional && meta.options.defaultValue === undefined) required.push(jsonKey);
		}
		const schema = { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
		definitions[name] = schema;
		building.delete(target);
		return schema;
	};

	const root = buildDefinition(ctor);
	const rootName = ctor.name || 'Anonymous';
	delete definitions[rootName];
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		...root,
		...(Object.keys(definitions).length ? { $defs: definitions } : {}),
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
export interface IJSONDiscriminatorOptions<T = unknown> {
	/** Constructor used when the discriminator field is absent. */
	fallback?: Constructor<T>;
}

export function JSONDiscriminator<T = unknown>(field: string, options: IJSONDiscriminatorOptions<T> = {}): ClassDecorator {
	return (target) => {
		(target as AnyFn)[D] = field;
		if (options.fallback) {
			(target as AnyFn)[F] = options.fallback;
		}
	};
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
	const raw = (typeof data === 'string' ? parseJSON(data, _path) : data) as PlainObj;
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
		if (discValue === undefined) {
			const fallback = (ctor as AnyFn)[F] as Constructor<V> | undefined;
			if (!fallback) {
				throw new SerializationError(`Missing discriminator field "${discField}"`, childPath(_path, discField), SerializationErrorCode.MISSING_DISCRIMINATOR);
			}
			if (fallback !== ctor) {
				return deserialize(fallback, raw, _path, options);
			}
		} else if (subtypes) {
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

	function convertValue(val: unknown, ctorOrEnum: Constructor | Record<string, string | number> | null, path: string | (() => string), codec: JSONCodec | null): unknown {
		if (val === null || val === undefined) {
			return val;
		}
		if (codec) {
			try {
				return codec.deserialize(val);
			} catch (cause) {
				throw new SerializationError('Codec deserialization failed', typeof path === 'function' ? path() : path, SerializationErrorCode.TRANSFORM_FAILED, cause);
			}
		}

		if (!ctorOrEnum) {
			return val;
		}

		// An object supplied as explicit type metadata can only represent an enum.
		// This contextual check also supports one-member string enums, which are
		// otherwise indistinguishable from arbitrary one-property objects at runtime.
		if (typeof ctorOrEnum === 'object' || isEnum(ctorOrEnum)) {
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
	let instance: V;
	try {
		instance = new ctor();
	} catch (cause) {
		throw new SerializationError(`Constructor for "${ctor.name || 'Object'}" failed`, _path, SerializationErrorCode.CONSTRUCTION_FAILED, cause);
	}
	const metas = allMetas(ctor);
	for (const meta of metas) {
		const { propertyKey, options: metaOptions, explicitName } = meta;
		const jsonKey = explicitName ? metaOptions.name : (options.namingStrategy ? options.namingStrategy(propertyKey) : metaOptions.name);
		const getPath = () => childPath(_path, jsonKey);
		const inputKey = [jsonKey, ...metaOptions.aliases].find(key => Object.prototype.hasOwnProperty.call(raw, key));
		const hasKey = inputKey !== undefined;

		let rawValue: unknown = hasKey ? raw[inputKey] : undefined;

		if (hasKey) {
			seenKeys.add(inputKey as string);
		}

		if (rawValue === undefined) {
			const def = resolveDefault(metaOptions, getPath());
			if (def !== undefined) {
				let vResult: boolean | string | void;
				try {
					vResult = metaOptions.validate(def);
				} catch (cause) {
					throw new SerializationError(`Validation failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.VALIDATION_FAILED, cause);
				}
				if (vResult === false || typeof vResult === 'string') {
					throw new SerializationError(typeof vResult === 'string' ? vResult : `Validation failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.VALIDATION_FAILED);
				}
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
				map.set(k, convertValue(v, NestedCtor, () => childPath(getPath(), k), metaOptions.codec));
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
				set.add(convertValue(rawValue[i], NestedCtor, () => `${getPath()}[${i}]`, metaOptions.codec));
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
				convertValue(item, NestedCtor, () => `${getPath()}[${i}]`, metaOptions.codec),
			);
		} else {
			// convertValue handles null/undefined, enum validation, and recursion
			rawValue = convertValue(rawValue, NestedCtor, getPath, metaOptions.codec);
		}

		try {
			rawValue = metaOptions.deserializeTransform(rawValue);
		} catch (cause) {
			throw new SerializationError(`Deserialization transform failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.TRANSFORM_FAILED, cause);
		}

		let vResult: boolean | string | void;
		try {
			vResult = metaOptions.validate(rawValue as V);
		} catch (cause) {
			throw new SerializationError(`Validation failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.VALIDATION_FAILED, cause);
		}
		if (vResult === false || typeof vResult === 'string') {
			throw new SerializationError(typeof vResult === 'string' ? vResult : `Validation failed for property "${jsonKey}"`, getPath(), SerializationErrorCode.VALIDATION_FAILED);
		}

		(instance as PlainObj)[propertyKey] = rawValue;
	}

	if (options.strict) {
		for (const k of Object.keys(raw)) {
			if (!seenKeys.has(k)) {
				throw new SerializationError(`Unexpected property "${k}" in strict mode`, childPath(_path, k), SerializationErrorCode.UNEXPECTED_PROPERTY);
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
	const raw = typeof data === 'string' ? (parseJSON(data, path) as PlainObj[]) : data;
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
function serializeInternal<V extends object>(instance: V, _path: string, options: ISerializeOptions, active: WeakSet<object>): PlainObj {
	if (instance === null || instance === undefined) {
		throw new SerializationError('Cannot serialize null/undefined', _path, SerializationErrorCode.NULL_INPUT);
	}

	const ctor = instance.constructor as Constructor<V>;
	if (!isSerializable(ctor)) {
		throw new SerializationError(`Cannot serialize instance of unmarked class "${ctor.name || 'Object'}"`, _path, SerializationErrorCode.UNMARKED_CLASS);
	}
	if (active.has(instance)) {
		throw new SerializationError('Cannot serialize a circular object graph', _path, SerializationErrorCode.CIRCULAR_REFERENCE);
	}
	active.add(instance);

	try {
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
		const getPath = () => childPath(_path, jsonKey);
		if (metaOptions.sensitive && !options.includeSensitive) {
			continue;
		}
		if (options.groups?.length && metaOptions.groups.length && !metaOptions.groups.some(group => options.groups?.includes(group))) {
			continue;
		}

		let value: unknown;
		try {
			value = (instance as PlainObj)[propertyKey];
		} catch (cause) {
			throw new SerializationError(`Reading property "${propertyKey}" failed`, getPath(), SerializationErrorCode.TRANSFORM_FAILED, cause);
		}
		if (value !== undefined && value !== null) {
			try {
				value = metaOptions.serializeTransform(value as never) as unknown;
			} catch (cause) {
				throw new SerializationError(`Serialization transform failed for property "${propertyKey}"`, getPath(), SerializationErrorCode.TRANSFORM_FAILED, cause);
			}
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

		function serializeValue(v: unknown, pathGetter: () => string, codec: JSONCodec | null = null): unknown {
			if (v === null || v === undefined) {
				return v;
			}
			if (codec) {
				try {
					v = codec.serialize(v);
				} catch (cause) {
					throw new SerializationError('Codec serialization failed', pathGetter(), SerializationErrorCode.TRANSFORM_FAILED, cause);
				}
			}
			if (v === null || v === undefined) {
				return v;
			}

			if (v instanceof Date) {
				return v.toISOString();
			}

			if (v instanceof URL) {
				return v.toString();
			}

			if (typeof v === 'bigint') {
				return v.toString();
			}

			if (Array.isArray(v)) {
				const valuePath = pathGetter();
				if (active.has(v)) {
					throw new SerializationError('Cannot serialize a circular object graph', valuePath, SerializationErrorCode.CIRCULAR_REFERENCE);
				}
				active.add(v);
				try {
					return v.map((item, index) => serializeValue(item, () => `${valuePath}[${index}]`));
				} finally {
					active.delete(v);
				}
			}

			if (typeof v === 'object') {
				const valuePath = pathGetter();
				const proto = Object.getPrototypeOf(v);
				if (proto === Object.prototype || proto === null) {
					if (active.has(v)) {
						throw new SerializationError('Cannot serialize a circular object graph', valuePath, SerializationErrorCode.CIRCULAR_REFERENCE);
					}
					active.add(v);
					try {
						const plain = Object.create(null) as PlainObj;
						for (const [key, item] of Object.entries(v as PlainObj)) {
							setObjectKey(plain, key, serializeValue(item, () => childPath(valuePath, key)));
						}
						return plain;
					} finally {
						active.delete(v);
					}
				}
				return serializeInternal(v as object, valuePath, options, active);
			}

			return v;
		}

		if (metaOptions.isMap && !(value instanceof Map)) {
			throw new SerializationError(`Expected Map for property "${propertyKey}"`, getPath(), SerializationErrorCode.INVALID_COLLECTION);
		}
		if (metaOptions.isSet && !(value instanceof Set)) {
			throw new SerializationError(`Expected Set for property "${propertyKey}"`, getPath(), SerializationErrorCode.INVALID_COLLECTION);
		}
		if (metaOptions.isArray && !Array.isArray(value)) {
			throw new SerializationError(`Expected array for property "${propertyKey}"`, getPath(), SerializationErrorCode.INVALID_COLLECTION);
		}

		if (metaOptions.isMap) {
			const obj = Object.create(null) as PlainObj;
			for (const [k, v] of (value as Map<string, unknown>)) {
				setObjectKey(obj, k, serializeValue(v, () => childPath(getPath(), k), metaOptions.codec));
			}

			setObjectKey(result, jsonKey, obj);
			continue;
		}

		if (metaOptions.isSet) {
			setObjectKey(result, jsonKey, Array.from(value as Set<unknown>).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`, metaOptions.codec)
			));
			continue;
		}

		if (Array.isArray(value)) {
			setObjectKey(result, jsonKey, (value as unknown[]).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`, metaOptions.codec)
			));
			continue;
		}

		setObjectKey(result, jsonKey, serializeValue(value, getPath, metaOptions.codec));
	}

	const discField = (ctor as AnyFn)[D] as string | undefined;
	const subtypes = (ctor as AnyFn)[T] as Map<string, Constructor> | undefined;
	if (discField && subtypes && !Object.prototype.hasOwnProperty.call(result, discField)) {
		for (const [value, subtype] of subtypes) {
			if (subtype === ctor) {
				setObjectKey(result, discField, value);
				break;
			}
		}
	}

	return result;
	} finally {
		active.delete(instance);
	}
}

export function serialize<V extends object>(instance: V, _path = '$', options: ISerializeOptions = {}): PlainObj {
	return serializeInternal(instance, _path, options, new WeakSet<object>());
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
