import { test, expect } from 'vitest';
import { serialize, JSONProperty, Serializable, serializeAsync } from '../src';

test('invalid dates expose structured paths and preserve native causes', async () => {
	@Serializable()
	class Model {
		@JSONProperty({
			type:    Date,
			isArray: true,
		})
		public dates = [new Date(NaN)];
	}
	const failure = {
		name:  'SerializationError',
		code:  'TYPE_MISMATCH',
		path:  '$.dates[0]',
		cause: expect.any(RangeError),
	};

	try {
		serialize(new Model());
		expect.fail('Expected invalid Date to fail');
	} catch (error) {
		expect(error).toMatchObject(failure);
	}
	await expect(serializeAsync(new Model())).rejects.toMatchObject(failure);
});
