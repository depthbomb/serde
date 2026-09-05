import { expect, test } from 'vitest';
import { deserialize, deserializeAsync, JSONProperty, Serializable } from '../src/index';

test.each(['map', 'set'] as const)('%s runs transforms and validators after collection conversion', async kind => {
	const calls = [] as string[];
	@Serializable()
	class Collection {
		@JSONProperty({
			isMap: kind === 'map',
			isSet: kind === 'set',
			deserializeTransform: value => {
				expect(value).toBeInstanceOf(kind === 'map' ? Map : Set);
				calls.push('transform');

				return value;
			},
			validate: () => {
				calls.push('validate');

				return 'invalid collection';
			},
		})
		public values!: unknown;
	}
	const raw = {
		values: kind === 'map' ? Object.fromEntries([['a', 1]]) : [1],
	};

	expect(() => deserialize(Collection, raw)).toThrow('invalid collection');
	await expect(deserializeAsync(Collection, raw)).rejects.toMatchObject({
		code: 'VALIDATION_FAILED',
		path: '$.values',
	});
	expect(calls).toEqual(['transform', 'validate', 'transform', 'validate']);
});
