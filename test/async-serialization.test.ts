import { test, expect } from 'vitest';
import { serialize, JSONProperty, Serializable, serializeAsync } from '../src';

test('async serialization permits shared siblings and rejects ancestor cycles', async () => {
	@Serializable()
	class Child {
		@JSONProperty()
		public id = 1;
	}
	@Serializable()
	class Parent {
		@JSONProperty({
			isArray: true,
		})
		public children = [] as object[];
	}
	const child     = new Child();
	const parent    = new Parent();
	parent.children = [child, child];

	expect(await serializeAsync(parent)).toEqual(serialize(parent));
	parent.children = [parent];
	await expect(serializeAsync(parent)).rejects.toMatchObject({
		code: 'CIRCULAR_REFERENCE',
		path: '$.children[0]',
	});
});

test('async serialization preserves codecs and synchronous wire transforms', async () => {
	@Serializable()
	class Child {
		@JSONProperty()
		public id = 7;
	}
	const codec = {
		serialize:   (value: Child) => value.id,
		deserialize: (value: unknown) => Object.assign(new Child(), {
			id: Number(value),
		}),
	};
	@Serializable()
	class Parent {
		@JSONProperty({
			codec,
		})
		public child = new Child();

		@JSONProperty({
			codec,
			isArray: true,
		})
		public children = [new Child()];

		@JSONProperty({
			serializeTransform: (value: Child) => value.id,
		})
		public transformed = new Child();
	}
	const value = new Parent();

	expect(await serializeAsync(value)).toEqual({
		child:       7,
		children:    [7],
		transformed: 7,
	});
	expect(await serializeAsync(value)).toEqual(serialize(value));
});

test('async hooks run inside plain objects and nested array wrappers', async () => {
	@Serializable()
	class Child {
		@JSONProperty({
			serializeAsyncTransform: async (value: string) => value.toUpperCase(),
		})
		public value = 'lowercase';
	}
	@Serializable()
	class Parent {
		@JSONProperty()
		public wrapper = {
			children: [[new Child()]],
		};
	}

	expect(await serializeAsync(new Parent())).toEqual({
		wrapper: {
			children: [[{
				value: 'LOWERCASE',
			}]],
		},
	});
});

test('async transforms normalize unsupported input before serialization', async () => {
	@Serializable()
	class Bytes {
		@JSONProperty({
			serializeAsyncTransform: async (value: Uint8Array) => Array.from(value),
		})
		public bytes = new Uint8Array([1, 2]);

		@JSONProperty({
			sensitive:               true,
			serializeAsyncTransform: async () => {
				throw new Error('Hidden transforms must not run');
			},
		})
		public secret = 'hidden';
	}
	@Serializable()
	class Parent {
		@JSONProperty({
			type: Bytes,
		})
		public child = new Bytes();
	}

	expect(await serializeAsync(new Parent())).toEqual({
		child: {
			bytes: [1, 2],
		},
	});
	expect(() => serialize(new Bytes())).toThrow('unmarked class');
});

test('async traversal invokes each transform once on a deep chain', async () => {
	let calls = 0;
	@Serializable()
	class Node {
		@JSONProperty({
			serializeTransform: (value: number) => {
				calls++;

				return value;
			},
		})
		public value = 1;

		@JSONProperty({
			type: () => Node,
		})
		public child?: Node;
	}
	const root = new Node();
	let tail   = root;
	for (let index = 1; index < 256; index++) {
		tail.child = new Node();
		tail       = tail.child;
	}
	const expected = serialize(root);
	calls          = 0;

	expect(await serializeAsync(root)).toEqual(expected);
	expect(calls).toBe(256);
});

test('async output cycles are rejected and escaped keys remain safe', async () => {
	@Serializable()
	class Model {
		@JSONProperty({
			name:                    '__proto__',
			serializeAsyncTransform: async (value: object) => value,
		})
		public value = {} as object;
	}
	const instance = new Model();
	const result   = await serializeAsync(instance);

	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.hasOwn(result, '__proto__')).toBe(true);
	instance.value = instance;
	await expect(serializeAsync(instance)).rejects.toMatchObject({
		code: 'CIRCULAR_REFERENCE',
		path: '$.__proto__',
	});
});

test('async normalization includes class instances produced by codecs', async () => {
	@Serializable()
	class WireValue {
		@JSONProperty({
			serializeAsyncTransform: async (value: string) => value.toUpperCase(),
		})
		public text = 'wire';
	}
	@Serializable()
	class Model {
		@JSONProperty({
			codec: {
				serialize:   () => new WireValue(),
				deserialize: () => 1,
			},
		})
		public value = 1;
	}

	expect(await serializeAsync(new Model())).toEqual({
		value: {
			text: 'WIRE',
		},
	});
});

test('async collection conversion preserves codecs and validates collection shapes', async () => {
	const codec = {
		serialize:   (value: number) => String(value),
		deserialize: (value: unknown) => Number(value),
	};
	@Serializable()
	class Model {
		@JSONProperty({
			codec,
			isMap: true,
		})
		public map = new Map([['key', 1]]);

		@JSONProperty({
			codec,
			isSet: true,
		})
		public set = new Set([2]);
	}
	const instance = new Model();

	expect(await serializeAsync(instance)).toEqual(serialize(instance));
	Object.assign(instance, {
		map: {},
	});
	await expect(serializeAsync(instance)).rejects.toMatchObject({
		code: 'INVALID_COLLECTION',
		path: '$.map',
	});
});
