import { SerializationError, SerializationErrorCode } from './errors';
import { serialize, deserialize, serializeAsync, deserializeAsync, getJSONProperties } from './';
import type { Constructor, ISerializeOptions, IDeserializeOptions } from './';

/** Options for patch key matching, serialization, and deserialization. */
export interface IPatchOptions extends IDeserializeOptions, ISerializeOptions {
	/** Reject patch keys that are not property names, canonical JSON names, or aliases. */
	strictPatch?: boolean;
}

/**
 * Serialize to a JSON string.
 *
 * @example
 * const json = toJSON(user);
 */
export function toJSON<V extends object>(instance: V, space?: number): string {
	return JSON.stringify(serialize(instance), null, space);
}

/**
 * Deserialize a JSON string to a class instance.
 *
 * @example
 * const user = fromJSON(User, '{"first_name":"Ada","age":36}');
 */
export function fromJSON<V>(ctor: Constructor<V>, json: string): V {
	return deserialize(ctor, json);
}

/**
 * Deep-clone a serializable instance by round-tripping through serialization. Guarantees a fully
 * independent copy with no shared references.
 *
 * Note: This performs full serialization and deserialization. For large object graphs, consider
 * manual cloning if performance is critical.
 *
 * @example
 * const copy = clone(User, user);
 */
export function clone<V extends object>(ctor: Constructor<V>, instance: V): V {
	return deserialize(ctor, serialize(instance, '$', {
		includeSensitive: true,
	}));
}

export async function toJSONAsync<V extends object>(instance: V, space?: number): Promise<string> {
	return JSON.stringify(await serializeAsync(instance), null, space);
}

export async function fromJSONAsync<V>(ctor: Constructor<V>, json: string): Promise<V> {
	return deserializeAsync(ctor, json);
}

/**
 * Merge a partial plain-object patch into an existing instance. Keys present in `partial` override
 * the current values; everything else is preserved.
 *
 * Note: This performs full serialization and deserialization. For simple updates, consider mutating
 * the instance directly if the type system allows.
 *
 * @example
 * const updated = patch(User, user, { age: 37 });
 */
export function patch<V extends object>(ctor: Constructor<V>, instance: V, partial: Record<string, unknown>, options: IPatchOptions = {}): V {
	const next = {
		...serialize(instance, '$', {
			...options,
			includeSensitive: true,
		}),
	} as Record<string, unknown>;
	const mappings = getJSONProperties(ctor, options.namingStrategy);
	const allowed  = new Set(mappings.flatMap(({ propertyKey, jsonKey, aliases }) => [propertyKey, jsonKey, ...aliases]));

	if (options.strictPatch) {
		for (const key of Object.keys(partial)) {
			if (!allowed.has(key)) {
				throw new SerializationError(`Unexpected patch property "${key}"`, `$[${JSON.stringify(key)}]`, SerializationErrorCode.UNEXPECTED_PROPERTY);
			}
		}
	}

	for (const { propertyKey, jsonKey, aliases } of mappings) {
		const inputKey = [propertyKey, jsonKey, ...aliases].find(key => Object.prototype.hasOwnProperty.call(partial, key));
		if (inputKey !== undefined) {
			Object.defineProperty(next, jsonKey, {
				value:        partial[inputKey],
				enumerable:   true,
				configurable: true,
				writable:     true,
			});
		}
	}

	for (const key of Object.keys(partial)) {
		if (!allowed.has(key)) {
			Object.defineProperty(next, key, {
				value:        partial[key],
				enumerable:   true,
				configurable: true,
				writable:     true,
			});
		}
	}

	return deserialize(ctor, next, '$', options);
}
