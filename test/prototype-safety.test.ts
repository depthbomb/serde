import { test, expect } from 'vitest';
import { serialize, deserialize, JSONProperty, Serializable, serializeAsync, deserializeAsync } from '../src';

test.each([
	['sync', deserialize],
	['async', deserializeAsync],
] as const)('%s deserialization preserves an instance prototype when assigning __proto__', async (_name, decode) => {
	@Serializable()
	class Model {}
	JSONProperty()(Model.prototype, '__proto__');
	const raw = JSON.parse('{"__proto__":{"injected":true}}');
	const instance = await decode(Model, raw);

	expect(Object.getPrototypeOf(instance)).toBe(Model.prototype);
	expect(Object.hasOwn(instance, '__proto__')).toBe(true);
	expect(Object.hasOwn(Object.getPrototypeOf(instance), 'injected')).toBe(false);
	expect(serialize(instance)).toEqual(raw);
});

test.each([null, { value: 'default' }])('default and nullable assignments safely handle __proto__: %j', value => {
	class Defaulted {}
	class Nullable {}
	JSONProperty({ defaultValue: () => value })(Defaulted.prototype, '__proto__');
	JSONProperty({ nullable: 'null' })(Nullable.prototype, '__proto__');
	const defaulted = deserialize(Defaulted, {});
	const nullable = deserialize(Nullable, JSON.parse('{"__proto__":null}'));

	expect(Object.getPrototypeOf(defaulted)).toBe(Defaulted.prototype);
	expect(Object.getOwnPropertyDescriptor(defaulted, '__proto__')?.value).toBe(value);
	expect(Object.getPrototypeOf(nullable)).toBe(Nullable.prototype);
	expect(Object.getOwnPropertyDescriptor(nullable, '__proto__')?.value).toBeNull();
});

test('async transforms safely replace the __proto__ property', async () => {
	class Model {}
	const transformed = { value: 'transformed' };
	JSONProperty({
		deserializeAsyncTransform: async () => transformed,
	})(Model.prototype, '__proto__');
	const instance = await deserializeAsync(Model, JSON.parse('{"__proto__":"input"}'));

	expect(Object.getPrototypeOf(instance)).toBe(Model.prototype);
	expect(Object.getOwnPropertyDescriptor(instance, '__proto__')?.value).toBe(transformed);
});

test('serializers reject null-prototype roots with a structured error', async () => {
	const raw = Object.create(null);
	const failure = {
		name: 'SerializationError',
		code: 'UNMARKED_CLASS',
		path: '$',
	};

	expect(() => serialize(raw)).toThrowError(expect.objectContaining(failure));
	await expect(serializeAsync(raw)).rejects.toMatchObject(failure);
});
