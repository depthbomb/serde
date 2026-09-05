import { SerializationError, SerializationErrorCode } from './errors';

type AnyFn    = Constructor & Record<PropertyKey, unknown>;
type PlainObj = Record<string, unknown>;
type AnyEnum  = Record<string, string | number>;
type DeserializationAssignments = WeakMap<object, Set<string>>;

interface IPropertyMeta<V = unknown> {
	propertyKey: string;
	options: Required<IJSONPropertyOptions<V>>;
	explicitName: boolean;
	hasDeserializeAsyncTransform: boolean;
	hasSerializeAsyncTransform: boolean;
	hasSerializeTransform: boolean;
	hasValidateAsync: boolean;
	resolvedType: Constructor<V> | AnyEnum | null;
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
	unknownProperties?: 'ignore' | 'error' | 'collect';
	unknownProperty?: string;
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
	/** Async transform applied by deserializeAsync after synchronous conversion. */
	deserializeAsyncTransform?: (value: T) => Promise<T>;
	/**
	 * Transform applied before serialization: typed value → raw JSON value.
	 * @example (d: Date) => d.toISOString()
	 */
	serializeTransform?: (value: T) => unknown;
	/** Async transform applied by serializeAsync to produce a raw JSON value. */
	serializeAsyncTransform?: (value: T) => Promise<unknown>;
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
	/** Async validator run by deserializeAsync. */
	validateAsync?: (value: T) => Promise<boolean | string | void>;
	groups?: string[];
	sensitive?: boolean;
}

const S = Symbol('serde.serializable');
const P = Symbol('serde.properties');
const D = Symbol('serde.discriminator');
const T = Symbol('serde.subtypes');
const F = Symbol('serde.fallback');
const V = Symbol('serde.version');
const metaVersions = new WeakMap<Constructor, number>();
const standardRegistrations = new WeakMap<object, Array<(ctor: AnyFn) => void>>();
const initializedStandardMetas = new WeakSet<Constructor>();
const metadataSymbol = getMetadataSymbol();

const enumValueCache    = new WeakMap<EnumType, (string | number)[]>();
const enumValueSetCache = new WeakMap<EnumType, Set<string | number>>();
const enumCache         = new WeakSet<EnumType>();

function getMetadataSymbol(): symbol {
	if (!Symbol.metadata) {
		Object.defineProperty(Symbol, 'metadata', {
			value: Symbol('Symbol.metadata'),
		});
	}

	return Symbol.metadata;
}

function registerStandardMetas(ctor: AnyFn): void {
	if (initializedStandardMetas.has(ctor) || !Object.prototype.hasOwnProperty.call(ctor, metadataSymbol)) {
		return;
	}

	const metadata = ctor[metadataSymbol];
	if (metadata && typeof metadata === 'object') {
		for (const register of standardRegistrations.get(metadata) ?? []) {
			register(ctor);
		}
		initializedStandardMetas.add(ctor);
	}
}

function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function setObjectKey(obj: PlainObj, key: string, value: unknown): void {
	if (key === '__proto__') {
		Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
		return;
	}
	obj[key] = value;
}

function serializeDate(value: Date, pathGetter: () => string): string {
	try {
		return value.toISOString();
	} catch (cause) {
		throw new SerializationError('Expected a valid Date', pathGetter(), SerializationErrorCode.TYPE_MISMATCH, cause);
	}
}

function serializeValue(v: unknown, pathGetter: () => string, codec: JSONCodec | null, options: ISerializeOptions, active: WeakSet<object>): unknown {
	if (v === null || v === undefined) return v;
	if (codec) {
		try {
			v = codec.serialize(v);
		} catch (cause) {
			throw new SerializationError('Codec serialization failed', pathGetter(), SerializationErrorCode.TRANSFORM_FAILED, cause);
		}
	}
	if (v === null || v === undefined) return v;
	if (v instanceof Date) {
		return serializeDate(v, pathGetter);
	}
	if (v instanceof URL) return v.toString();
	if (typeof v === 'bigint') return v.toString();
	if (Array.isArray(v)) {
		const valuePath = pathGetter();
		if (active.has(v)) throw new SerializationError('Cannot serialize a circular object graph', valuePath, SerializationErrorCode.CIRCULAR_REFERENCE);
		active.add(v);
		try {
			return v.map((item, index) => serializeValue(item, () => `${valuePath}[${index}]`, null, options, active));
		} finally {
			active.delete(v);
		}
	}
	if (typeof v === 'object') {
		const valuePath = pathGetter();
		const proto = Object.getPrototypeOf(v);
		if (proto === Object.prototype || proto === null) {
			if (active.has(v)) throw new SerializationError('Cannot serialize a circular object graph', valuePath, SerializationErrorCode.CIRCULAR_REFERENCE);
			active.add(v);
			try {
				const plain = Object.create(null) as PlainObj;
				for (const [key, item] of Object.entries(v as PlainObj)) {
					setObjectKey(plain, key, serializeValue(item, () => childPath(valuePath, key), null, options, active));
				}
				return plain;
			} finally {
				active.delete(v);
			}
		}
		return serializeInternal(v, valuePath, options, active);
	}
	return v;
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
		registerStandardMetas(owner as AnyFn);
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

/** Get all valid values from an enum object */
export function getEnumValues(enumObj: Record<string, string | number>): (string | number)[] {
	const cached = enumValueCache.get(enumObj as EnumType);
	if (cached) {
		return cached;
	}

	const values = new Set<string | number>();
	for (const [k, v] of Object.entries(enumObj)) {
		if (typeof v === 'string' && String(Number(k)) === k && enumObj[v] === Number(k)) {
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
	return typeof ctor === 'function' && (ctor as AnyFn)[S] === true;
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

	const registered = new WeakMap<Constructor, Set<string>>();
	const register = (ctor: AnyFn, key: string): void => {
		const registeredKeys = registered.get(ctor);
		if (registeredKeys?.has(key)) {
			return;
		}

		if (typeof key !== 'string') {
			throw new Error('@JSONProperty only supports string keys.');
		}

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
			deserializeAsyncTransform: options.deserializeAsyncTransform ?? (async (v) => v),
			serializeTransform: options.serializeTransform ?? ((v) => v),
			serializeAsyncTransform: options.serializeAsyncTransform ?? (async (v) => v),
			defaultValue: options.defaultValue as V,
			validate: options.validate ?? (() => undefined),
			validateAsync: options.validateAsync ?? (async () => undefined),
			groups: options.groups ?? [],
			sensitive: options.sensitive ?? false,
		} as Required<IJSONPropertyOptions<V>>;

		const idx = metas.findIndex((m) => m.propertyKey === key);
		const entry: IPropertyMeta<V> = {
			propertyKey: key,
			options: full,
			explicitName: options.name !== undefined,
			hasDeserializeAsyncTransform: options.deserializeAsyncTransform !== undefined,
			hasSerializeAsyncTransform: options.serializeAsyncTransform !== undefined,
			hasSerializeTransform: options.serializeTransform !== undefined,
			hasValidateAsync: options.validateAsync !== undefined,
			resolvedType: options.type && (typeof options.type === 'object' || (typeof options.type === 'function' && Object.prototype.hasOwnProperty.call(options.type, 'prototype')))
				? options.type as Constructor<V> | AnyEnum
				: null,
		};
		if (idx >= 0) {
			metas[idx] = entry as IPropertyMeta<unknown>;
		} else {
			metas.push(entry as IPropertyMeta<unknown>);
		}
		metaVersions.set(ctor, (metaVersions.get(ctor) ?? 0) + 1);
		registered.set(ctor, (registeredKeys ?? new Set<string>()).add(key));
	};

	return (target, propertyKey) => {
		if (propertyKey && typeof propertyKey === 'object' && typeof propertyKey.addInitializer === 'function') {
			if (propertyKey.private || propertyKey.static || typeof propertyKey.name !== 'string') {
				throw new Error('@JSONProperty only supports public instance string keys.');
			}
			const key = propertyKey.name;
			const metadata = propertyKey.metadata as object | undefined;
			if (metadata) {
				const registrations = standardRegistrations.get(metadata) ?? [];
				registrations.push(ctor => register(ctor, key));
				standardRegistrations.set(metadata, registrations);
				return;
			}

			propertyKey.addInitializer(function (this: object) {
				register(this.constructor as AnyFn, key);
			});
			return;
		}

		const key = typeof propertyKey === 'string' ? propertyKey : (propertyKey as any)?.name;
		if (!target || typeof key !== 'string') {
			throw new Error('@JSONProperty only supports string keys.');
		}
		register(target.constructor as AnyFn, key);
	};
}

/** Read-only property-to-JSON mappings for a serializable class. */
export function getJSONProperties(ctor: Constructor, namingStrategy?: NamingStrategy): ReadonlyArray<Readonly<{
	propertyKey: string;
	jsonKey:     string;
	aliases:     readonly string[];
}>> {
	return allMetas(ctor).map(({ propertyKey, options, explicitName }) => Object.freeze({
		propertyKey,
		jsonKey: explicitName ? options.name : (namingStrategy ? namingStrategy(propertyKey) : options.name),
		aliases: Object.freeze([...options.aliases]),
	}));
}

/** Generate a JSON Schema (draft 2020-12) from serializer metadata. */
export function generateJSONSchema(ctor: Constructor, namingStrategy?: NamingStrategy): Record<string, unknown> {
	const definitions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	const building = new Set<Constructor>();
	const names    = new Map<Constructor, string>();
	const used     = new Set<string>();
	const definitionName = (target: Constructor): string => {
		const existing = names.get(target);
		if (existing) {
			return existing;
		}

		const base = (target.name || 'Anonymous').replace(/[^A-Za-z0-9_$.-]/g, '_');
		let name   = base;
		let suffix = 2;
		while (used.has(name)) {
			name = `${base}_${suffix++}`;
		}
		names.set(target, name);
		used.add(name);

		return name;
	};

	const valueSchema = (meta: IPropertyMeta): Record<string, unknown> => {
		if (meta.options.codec?.schema) {
			return { ...meta.options.codec.schema };
		}
		const type = meta.resolvedType ?? resolveType(meta.options);
		if (!type) return {};
		if (typeof type === 'object' || isEnum(type)) return { enum: getEnumValues(type as AnyEnum) };
		if (type === String) return { type: 'string' };
		if (type === Number) return { type: 'number' };
		if (type === Boolean) return { type: 'boolean' };
		if ((type as unknown) === BigInt) return { type: 'string', pattern: '^-?\\d+$' };
		if (type === Date) return { type: 'string', format: 'date-time' };
		if (type === URL) return { type: 'string', format: 'uri' };
		if (type === ctor && building.has(type)) return { $ref: '#' };
		buildDefinition(type as Constructor);
		return { $ref: `#/$defs/${definitionName(type as Constructor)}` };
	};

	const buildDefinition = (target: Constructor): Record<string, unknown> => {
		const name = definitionName(target);
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
		const version = (target as AnyFn)[V] as { current: number; field: string } | undefined;
		if (version) {
			properties[version.field] = {
				type:  'integer',
				const: version.current,
			};
			required.push(version.field);
		}

		const discriminator = (target as AnyFn)[D] as string | undefined;
		if (discriminator) {
			const subtypes = (target as AnyFn)[T] as Map<string, Constructor> | undefined;
			const values   = Array.from(subtypes ?? []).filter(([, subtype]) => subtype === target).map(([value]) => value);
			properties[discriminator] = {
				...properties[discriminator] as PlainObj,
				type: 'string',
				...(values.length ? { enum: values } : {}),
			};
			if (values.length || !(target as AnyFn)[F]) {
				required.push(discriminator);
			}
		}

		const schema = { type: 'object', properties, additionalProperties: false, ...(required.length ? { required: [...new Set(required)] } : {}) };
		definitions[name] = schema;
		building.delete(target);
		return schema;
	};

	const root = buildDefinition(ctor);
	const rootName = definitionName(ctor);
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

export type JSONMigration = (data: Readonly<PlainObj>) => PlainObj;

export interface IJSONVersionOptions {
	field?: string;
	migrations?: Readonly<Record<number, JSONMigration>>;
}

/** Configure versioned input migrations. Migration N upgrades version N to N + 1. */
export function JSONVersion(current: number, options: IJSONVersionOptions = {}): ClassDecorator {
	if (!Number.isInteger(current) || current < 0) {
		throw new Error('@JSONVersion current version must be a non-negative integer.');
	}
	return target => {
		(target as AnyFn)[V] = {
			current,
			field: options.field ?? '$version',
			migrations: options.migrations ?? {},
		};
	};
}

function deserializeInternal<V>(ctor: Constructor<V>, data: PlainObj | string, _path: string, options: IDeserializeOptions, assignments?: DeserializationAssignments): V {
	let raw = (typeof data === 'string' ? parseJSON(data, _path) : data) as PlainObj;
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

	const versionConfig = (ctor as AnyFn)[V] as { current: number; field: string; migrations: Readonly<Record<number, JSONMigration>> } | undefined;
	if (versionConfig) {
		let version = raw[versionConfig.field] === undefined ? 0 : Number(raw[versionConfig.field]);
		if (!Number.isInteger(version) || version < 0 || version > versionConfig.current) {
			throw new SerializationError(`Unsupported schema version "${raw[versionConfig.field]}"`, childPath(_path, versionConfig.field), SerializationErrorCode.UNSUPPORTED_VERSION);
		}
		while (version < versionConfig.current) {
			const migration = versionConfig.migrations[version];
			if (!migration) {
				throw new SerializationError(`Missing migration from schema version ${version}`, childPath(_path, versionConfig.field), SerializationErrorCode.MIGRATION_FAILED);
			}
			try {
				raw = migration(Object.freeze({ ...raw }));
			} catch (cause) {
				throw new SerializationError(`Migration from schema version ${version} failed`, childPath(_path, versionConfig.field), SerializationErrorCode.MIGRATION_FAILED, cause);
			}
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				throw new SerializationError(`Migration from schema version ${version} returned a non-object`, _path, SerializationErrorCode.MIGRATION_FAILED);
			}
			version++;
			raw = { ...raw, [versionConfig.field]: version };
		}
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
				return deserializeInternal(fallback, raw, _path, options, assignments);
			}
		} else if (subtypes) {
			const sub = subtypes.get(discValue);
			if (!sub) {
				throw new SerializationError(`Unknown discriminator value "${discValue}" for field "${discField}"`, _path, SerializationErrorCode.UNKNOWN_DISCRIMINATOR);
			}

			// avoid recursion if the resolved subtype is the same constructor
			if (sub !== ctor) {
				return deserializeInternal(sub, raw, _path, options, assignments);
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

		return deserializeInternal(ctorOrEnum as Constructor, val as PlainObj, typeof path === 'function' ? path() : path, options, assignments);
	}

	const seenKeys = new Set<string>();
	if (versionConfig) {
		seenKeys.add(versionConfig.field);
	}

	if (discField) {
		seenKeys.add(discField);
	}
	let instance: V;
	try {
		instance = new ctor();
	} catch (cause) {
		throw new SerializationError(`Constructor for "${ctor.name || 'Object'}" failed`, _path, SerializationErrorCode.CONSTRUCTION_FAILED, cause);
	}
	const assignedProperties = assignments ? new Set<string>() : undefined;
	if (assignedProperties) {
		assignments?.set(instance as object, assignedProperties);
	}

	const metas = allMetas(ctor);
	for (const meta of metas) {
		const { propertyKey, options: metaOptions, explicitName } = meta;
		const jsonKey = explicitName ? metaOptions.name : (options.namingStrategy ? options.namingStrategy(propertyKey) : metaOptions.name);
		const getPath = () => childPath(_path, jsonKey);
		const inputKey = [jsonKey, ...metaOptions.aliases].find(key => Object.prototype.hasOwnProperty.call(raw, key));
		const hasKey = inputKey !== undefined;

		let rawValue: unknown = hasKey ? raw[inputKey] : undefined;

		seenKeys.add(jsonKey);
		for (const alias of metaOptions.aliases) {
			seenKeys.add(alias);
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
				assignedProperties?.add(propertyKey);
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

		const NestedCtor = meta.resolvedType ?? resolveType(metaOptions);

		if (metaOptions.isMap) {
			if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
				throw new SerializationError(`Expected object for map property "${jsonKey}"`, getPath(), SerializationErrorCode.TYPE_MISMATCH);
			}

			const map = new Map<string, unknown>();
			for (const [k, v] of Object.entries(rawValue as PlainObj)) {
				// convertValue handles null/undefined, enum validation, and recursion
				map.set(k, convertValue(v, NestedCtor, () => childPath(getPath(), k), metaOptions.codec));
			}

			rawValue = map;
		} else if (metaOptions.isSet) {
			if (!Array.isArray(rawValue)) {
				throw new SerializationError(`Expected array for set property "${jsonKey}"`, getPath(), SerializationErrorCode.NOT_AN_ARRAY);
			}

			const set = new Set<unknown>();
			for (let i = 0; i < rawValue.length; i++) {
				set.add(convertValue(rawValue[i], NestedCtor, () => `${getPath()}[${i}]`, metaOptions.codec));
			}

			rawValue = set;
		} else if (metaOptions.isArray) {
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
		assignedProperties?.add(propertyKey);
	}

	const unknownMode = options.unknownProperties ?? (options.strict ? 'error' : 'ignore');
	if (unknownMode !== 'ignore') {
		const unknown = Object.create(null) as PlainObj;
		for (const k of Object.keys(raw)) {
			if (!seenKeys.has(k)) {
				if (unknownMode === 'error') {
					throw new SerializationError(`Unexpected property "${k}"`, childPath(_path, k), SerializationErrorCode.UNEXPECTED_PROPERTY);
				}
				Object.defineProperty(unknown, k, { value: raw[k], enumerable: true, configurable: true, writable: true });
			}
		}
		if (unknownMode === 'collect') {
			if (!options.unknownProperty) {
				throw new SerializationError('unknownProperty is required when collecting unknown keys', _path, SerializationErrorCode.UNEXPECTED_PROPERTY);
			}
			Object.defineProperty(instance as object, options.unknownProperty, { value: unknown, enumerable: true, configurable: true, writable: true });
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
export function deserialize<V>(ctor: Constructor<V>, data: PlainObj | string, path = '$', options: IDeserializeOptions = {}): V {
	return deserializeInternal(ctor, data, path, options);
}

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
				setObjectKey(obj, k, serializeValue(v, () => childPath(getPath(), k), metaOptions.codec, options, active));
			}

			setObjectKey(result, jsonKey, obj);
			continue;
		}

		if (metaOptions.isSet) {
			setObjectKey(result, jsonKey, Array.from(value as Set<unknown>).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`, metaOptions.codec, options, active)
			));
			continue;
		}

		if (Array.isArray(value)) {
			setObjectKey(result, jsonKey, (value as unknown[]).map((item, i) =>
				serializeValue(item, () => `${getPath()}[${i}]`, metaOptions.codec, options, active)
			));
			continue;
		}

		setObjectKey(result, jsonKey, serializeValue(value, getPath, metaOptions.codec, options, active));
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
	const versionConfig = (ctor as AnyFn)[V] as { current: number; field: string } | undefined;
	if (versionConfig) {
		setObjectKey(result, versionConfig.field, versionConfig.current);
	}

	return result;
	} finally {
		active.delete(instance);
	}
}

/** Deserialize and then run async property transforms and validators recursively. */
export async function deserializeAsync<V>(ctor: Constructor<V>, data: PlainObj | string, _path = '$', options: IDeserializeOptions = {}): Promise<V> {
	const assignments = new WeakMap<object, Set<string>>();
	const instance    = deserializeInternal(ctor, data, _path, options, assignments);

	const applyAsync = async (value: object, path: string): Promise<void> => {
		for (const meta of allMetas(value.constructor as Constructor)) {
			const assignedProperties = assignments.get(value);
			if (assignedProperties && !assignedProperties.has(meta.propertyKey)) {
				continue;
			}

			const jsonKey = meta.explicitName ? meta.options.name : (options.namingStrategy ? options.namingStrategy(meta.propertyKey) : meta.options.name);
			const valuePath = childPath(path, jsonKey);
			let current = (value as PlainObj)[meta.propertyKey];
			const recurse = async (item: unknown, itemPath: string): Promise<void> => {
				if (item && typeof item === 'object' && isSerializable(item.constructor as Constructor)) {
					await applyAsync(item, itemPath);
				}
			};
			if (Array.isArray(current)) {
				await Promise.all(current.map((item, index) => recurse(item, `${valuePath}[${index}]`)));
			} else if (current instanceof Set) {
				await Promise.all(Array.from(current).map((item, index) => recurse(item, `${valuePath}[${index}]`)));
			} else if (current instanceof Map) {
				await Promise.all(Array.from(current, ([key, item]) => recurse(item, childPath(valuePath, String(key)))));
			} else {
				await recurse(current, valuePath);
			}

			if (meta.hasDeserializeAsyncTransform) {
				try {
					current = await meta.options.deserializeAsyncTransform(current as never);
					(value as PlainObj)[meta.propertyKey] = current;
				} catch (cause) {
					throw new SerializationError(`Async deserialization transform failed for property "${jsonKey}"`, valuePath, SerializationErrorCode.TRANSFORM_FAILED, cause);
				}
			}
			if (meta.hasValidateAsync) {
				let result: boolean | string | void;
				try {
					result = await meta.options.validateAsync(current as never);
				} catch (cause) {
					throw new SerializationError(`Async validation failed for property "${jsonKey}"`, valuePath, SerializationErrorCode.VALIDATION_FAILED, cause);
				}
				if (result === false || typeof result === 'string') {
					throw new SerializationError(typeof result === 'string' ? result : `Async validation failed for property "${jsonKey}"`, valuePath, SerializationErrorCode.VALIDATION_FAILED);
				}
			}
		}
	};

	await applyAsync(instance as object, _path);
	return instance;
}

export async function deserializeArrayAsync<V>(ctor: Constructor<V>, data: PlainObj[] | string, path = '$', options: IDeserializeOptions = {}): Promise<V[]> {
	const raw = typeof data === 'string' ? (parseJSON(data, path) as PlainObj[]) : data;
	if (!Array.isArray(raw)) {
		throw new SerializationError('Expected an array at root', path, SerializationErrorCode.NOT_AN_ARRAY);
	}
	return Promise.all(raw.map((item, index) => deserializeAsync(ctor, item, `${path}[${index}]`, options)));
}

export function serialize<V extends object>(instance: V, _path = '$', options: ISerializeOptions = {}): PlainObj {
	return serializeInternal(instance, _path, options, new WeakSet<object>());
}

/** Serialize while applying async property transforms recursively. */
export async function serializeAsync<V extends object>(instance: V, _path = '$', options: ISerializeOptions = {}): Promise<PlainObj> {
	const result = serialize(instance, _path, options);
	const active = new WeakSet<object>();

	const normalize = async (value: unknown, path: string): Promise<unknown> => {
		if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
		if (typeof value === 'bigint') return value.toString();
		if (value instanceof Date) {
			return serializeDate(value, () => path);
		}
		if (value instanceof URL) return value.toString();
		if (typeof value !== 'object') return value;
		if (active.has(value)) throw new SerializationError('Cannot serialize a circular object graph', path, SerializationErrorCode.CIRCULAR_REFERENCE);
		active.add(value);
		try {
			if (isSerializable(value.constructor as Constructor)) return await serializeAsync(value, path, options);
			if (Array.isArray(value) || value instanceof Set) {
				const items = [] as unknown[];
				for (const item of value) {
					items.push(await normalize(item, `${path}[${items.length}]`));
				}

				return items;
			}
			if (value instanceof Map) {
				const object = Object.create(null) as PlainObj;
				for (const [key, item] of value) object[String(key)] = await normalize(item, childPath(path, String(key)));
				return object;
			}
			const object = Object.create(null) as PlainObj;
			for (const [key, item] of Object.entries(value)) object[key] = await normalize(item, childPath(path, key));
			return object;
		} finally {
			active.delete(value);
		}
	};

	for (const meta of allMetas(instance.constructor as Constructor)) {
		const jsonKey = meta.explicitName ? meta.options.name : (options.namingStrategy ? options.namingStrategy(meta.propertyKey) : meta.options.name);
		if (!Object.prototype.hasOwnProperty.call(result, jsonKey)) continue;
		if (!meta.hasSerializeAsyncTransform) {
			if (meta.options.codec || meta.hasSerializeTransform) {
				continue;
			}

			const typed = (instance as PlainObj)[meta.propertyKey];
			if (typed && typeof typed === 'object') {
				result[jsonKey] = await normalize(typed, childPath(_path, jsonKey));
			}
			continue;
		}
		try {
			const transformed = await meta.options.serializeAsyncTransform((instance as PlainObj)[meta.propertyKey] as never);
			result[jsonKey] = await normalize(transformed, childPath(_path, jsonKey));
		} catch (cause) {
			if (cause instanceof SerializationError) throw cause;
			throw new SerializationError(`Async serialization transform failed for property "${jsonKey}"`, childPath(_path, jsonKey), SerializationErrorCode.TRANSFORM_FAILED, cause);
		}
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

export async function serializeArrayAsync<V extends object>(instances: V[], path = '$', options: ISerializeOptions = {}): Promise<PlainObj[]> {
	if (!Array.isArray(instances)) {
		throw new SerializationError('Expected an array', path, SerializationErrorCode.NOT_AN_ARRAY);
	}
	return Promise.all(instances.map((instance, index) => serializeAsync(instance, `${path}[${index}]`, options)));
}

export { clone, patch, toJSON, fromJSON, toJSONAsync, fromJSONAsync } from './utilities';
export type { IPatchOptions } from './utilities';
export { SerializationError, SerializationErrorCode } from './errors';
