import { serialize, deserialize } from './';
import type { Constructor } from './';

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
export function patch<V extends object>(ctor: Constructor<V>, instance: V, partial: Record<string, unknown>): V {
	const next = { ...serialize(instance), ...partial } as Record<string, unknown>;

	// Support TS property keys in patch input, even when @JSONProperty({ name }) remaps JSON keys.
	const P    = '__serde_p__';
	const seen = new Set<string>();

	let proto: object | null = ctor as unknown as object;
	while (proto && proto !== Function.prototype && proto !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(proto, P)) {
			for (const meta of (proto as Record<string, unknown>)[P] as Array<{ propertyKey: string; options: { name: string } }>) {
				if (seen.has(meta.propertyKey)) {
					continue;
				}

				seen.add(meta.propertyKey);
				if (Object.prototype.hasOwnProperty.call(partial, meta.propertyKey)) {
					next[meta.options.name] = partial[meta.propertyKey];
				}
			}
		}

		proto = Object.getPrototypeOf(proto);
	}

	return deserialize(ctor, next);
}
