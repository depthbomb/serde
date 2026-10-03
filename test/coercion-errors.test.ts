import { test, expect } from 'vitest';
import { deserialize, deserializeAsync, JSONProperty } from '../src';
import type { Constructor } from '../src';

test.each([
	['String', String],
	['Number', Number],
	['Boolean', Boolean],
	['Date', Date],
	['URL', URL],
	['BigInt', BigInt as unknown as Constructor],
] as const)('%s coercion failures retain structured paths and native causes', async (_name, type) => {
	class Model {}
	JSONProperty({
		type,
		isArray: true,
		name: 'wire.values',
	})(Model.prototype, 'values');
	const raw = JSON.parse('{"wire.values":[{"toString":null,"valueOf":null}]}');
	const failure = {
		name: 'SerializationError',
		code: 'TYPE_MISMATCH',
		path: '$["wire.values"][0]',
		cause: expect.any(TypeError),
	};

	expect(() => deserialize(Model, raw)).toThrowError(expect.objectContaining(failure));
	await expect(deserializeAsync(Model, raw)).rejects.toMatchObject(failure);
});

test('existing scalar validation errors retain their details', async () => {
	class Model {}
	JSONProperty({ type: Number })(Model.prototype, 'value');
	const failure = {
		code: 'TYPE_MISMATCH',
		path: '$.value',
		message: expect.stringContaining('Expected number, got "invalid"'),
		cause: undefined,
	};

	expect(() => deserialize(Model, { value: 'invalid' })).toThrowError(expect.objectContaining(failure));
	await expect(deserializeAsync(Model, { value: 'invalid' })).rejects.toMatchObject(failure);
});
