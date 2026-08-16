import { serialize, deserialize, getJSONProperties } from './';
import type { Constructor, IDeserializeOptions, ISerializeOptions } from './';
import { SerializationError, SerializationErrorCode } from './errors';

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
	return deserialize(ctor, serialize(instance));
}

/**
 * Merge a partial plain-object patch into an existing instance. Keys present in `partial` override
 *  the current values; everything else is preserved.
 *
 * Note: This performs full serialization and deserialization. For simple updates, consider mutating
 *  the instance directly if the type system allows.
 *
 * @example
 * const updated = patch(User, user, { age: 37 });
 */
export interface IPatchOptions extends IDeserializeOptions, ISerializeOptions {
	/** Reject patch keys that are neither property names nor serialized JSON names. */
	strictPatch?: boolean;
}

export function patch<V extends object>(ctor: Constructor<V>, instance: V, partial: Record<string, unknown>, options: IPatchOptions = {}): V {
	const next = { ...serialize(instance, '$', options), ...partial } as Record<string, unknown>;
	const mappings = getJSONProperties(ctor, options.namingStrategy);
	const allowed = new Set(mappings.flatMap(({ propertyKey, jsonKey }) => [propertyKey, jsonKey]));

	if (options.strictPatch) {
		for (const key of Object.keys(partial)) {
			if (!allowed.has(key)) {
				throw new SerializationError(`Unexpected patch property "${key}"`, `$[${JSON.stringify(key)}]`, SerializationErrorCode.UNEXPECTED_PROPERTY);
			}
		}
	}

	for (const { propertyKey, jsonKey } of mappings) {
		if (Object.prototype.hasOwnProperty.call(partial, propertyKey)) {
			next[jsonKey] = partial[propertyKey];
			if (propertyKey !== jsonKey) {
				delete next[propertyKey];
			}
		}
	}

	return deserialize(ctor, next, '$', options);
}
