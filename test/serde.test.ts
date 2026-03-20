import { describe, test, expect } from 'vitest';
import { clone, patch, toJSON, fromJSON } from '../src/utilities';
import {
	Serializable,
	JSONProperty,
	JSONDiscriminator,
	JSONSubType,
	deserialize,
	deserializeArray,
	serialize,
	serializeArray,
	isSerializable,
	isEnum,
	getEnumValues,
	__test_enumIsCached,
	__test_cachedValues,
	NamingStrategies,
} from '../src';
import { SerializationError, SerializationErrorCode } from '../src/errors';

// simple class
@Serializable()
class User {
	@JSONProperty({ name: 'first_name' })
	firstName!: string;

	@JSONProperty()
	age!: number;
}

describe('core serde functionality', () => {
	test('primitive properties serialize/deserialize', () => {
		const u = new User();
		u.firstName = 'Ada';
		u.age = 36;

		expect(serialize(u)).toEqual({ first_name: 'Ada', age: 36 });

		const v = deserialize(User, { first_name: 'Ada', age: 36 });
		expect(v).toBeInstanceOf(User);
		expect(v.firstName).toBe('Ada');
	});

	test('toJSON/fromJSON round trip', () => {
		const u = new User();
		u.firstName = 'Bob';
		u.age = 20;
		const json = toJSON(u);
		expect(fromJSON(User, json)).toEqual(u);
	});

	test('isSerializable helper', () => {
		expect(isSerializable(User)).toBe(true);
		expect(isSerializable(class {})).toBe(false);
	});

	test('deserialize with strict mode rejects unknown keys', () => {
		expect(() => deserialize(User, { first_name: 'A', age: 1, extra: true }, '$', { strict: true })).toThrow(SerializationError);
	});

	test('strict mode on arrays rejects extras', () => {
		expect(() => deserializeArray(User, [{ first_name: 'foo', age: 1, extra: 2 }], '$', { strict: true })).toThrow(SerializationError);
	});

	test('serializeArray / deserializeArray', () => {
		const arr = [new User(), new User()];
		arr[0].firstName = 'X';
		arr[0].age = 1;
		arr[1].firstName = 'Y';
		arr[1].age = 2;
		const plain = serializeArray(arr);
		expect(Array.isArray(plain)).toBe(true);
		expect(deserializeArray(User, plain)).toEqual(arr);
	});

	test('serializeArray checks input type', () => {
		expect(() => serializeArray(null as any)).toThrow(SerializationError);
		expect(() => serializeArray({} as any)).toThrow(SerializationError);
	});

	test('deserialize rejects non-object root inputs', () => {
		expect(() => deserialize(User, [] as any)).toThrow(SerializationError);
		expect(() => deserialize(User, 42 as any)).toThrow(SerializationError);
	});
});

// nested types, defaults, arrays, maps
@Serializable()
class Address {
	@JSONProperty()
	street!: string;

	@JSONProperty()
	city!: string;
}

@Serializable()
class Person {
	@JSONProperty()
	name!: string;

	@JSONProperty({ type: () => Address })
	address!: Address;
}

describe('nested / collection examples', () => {
	test('nested class deserializes properly', () => {
		const raw = { name: 'Grace', address: { street: '42', city: 'NY' } };
		const p = deserialize(Person, raw);
		expect(p.address).toBeInstanceOf(Address);
		expect(serialize(p)).toEqual(raw);
	});

	test('strict mode applies to nested objects', () => {
		expect(() => deserialize(Person, {
			name: 'Grace',
			address: { street: '42', city: 'NY', extra: true }
		}, '$', { strict: true })).toThrow(SerializationError);
	});

	@Serializable()
	class Order {
		@JSONProperty({ type: () => LineItem, isArray: true })
		items!: LineItem[];
	}

	@Serializable()
	class LineItem {
		@JSONProperty()
		name!: string;
		@JSONProperty()
		qty!: number;
	}

	test('array of classes', () => {
		const o = new Order();
		o.items = [{ name: 'a', qty: 1 }].map((x) => Object.assign(new LineItem(), x));
		const round = deserialize(Order, serialize(o));
		expect(round).toEqual(o);
	});

	@Serializable()
	class Catalog {
		@JSONProperty({ type: () => Product, isMap: true })
		products!: Map<string, Product>;
	}

	@Serializable()
	class Product {
		@JSONProperty()
		price!: number;
	}

	test('map property', () => {
		const cat = new Catalog();
		cat.products = new Map([['sku', Object.assign(new Product(), { price: 5 })]]);
		const plain = serialize(cat);
		expect(plain).toEqual({ products: { sku: { price: 5 } } });
		const back = deserialize(Catalog, plain);
		expect(back.products.get('sku')).toBeInstanceOf(Product);
	});

	@Serializable()
	class DateTest {
		@JSONProperty({ type: Date })
		date!: Date;

		@JSONProperty({ type: Date, isArray: true })
		dates!: Date[];

		@JSONProperty({ type: Date, isMap: true })
		dateMap!: Map<string, Date>;
	}

	test('built-in Date serialization and deserialization', () => {
		const d = new Date('2026-03-20T11:23:46.000Z');
		const t = new DateTest();
		t.date = d;
		t.dates = [d];
		t.dateMap = new Map([['today', d]]);

		const plain = serialize(t);
		expect(plain).toEqual({
			date: '2026-03-20T11:23:46.000Z',
			dates: ['2026-03-20T11:23:46.000Z'],
			dateMap: { today: '2026-03-20T11:23:46.000Z' }
		});

		const back = deserialize(DateTest, plain);
		expect(back.date).toBeInstanceOf(Date);
		expect(back.date.getTime()).toBe(d.getTime());
		expect(back.dates[0]).toBeInstanceOf(Date);
		expect(back.dateMap.get('today')).toBeInstanceOf(Date);
	});

	test('invalid Date deserialization throws TYPE_MISMATCH', () => {
		expect(() => deserialize(DateTest, { date: 'not-a-date' })).toThrow(SerializationError);
	});

	@Serializable()
	class CollectionsTest {
		@JSONProperty({ type: URL as any })
		url!: URL;

		@JSONProperty({ type: () => Product, isSet: true })
		productSet!: Set<Product>;
	}

	test('built-in Set and URL serialization and deserialization', () => {
		const targetUrl = new URL('https://example.com/foo');
		const p1 = new Product();
		p1.price = 10;
		const p2 = new Product();
		p2.price = 20;

		const t = new CollectionsTest();
		t.url = targetUrl;
		t.productSet = new Set([p1, p2]);

		const plain = serialize(t);
		expect(plain).toEqual({
			url: 'https://example.com/foo',
			productSet: [{ price: 10 }, { price: 20 }]
		});

		const back = deserialize(CollectionsTest, plain);
		expect(back.url).toBeInstanceOf(URL);
		expect(back.url.href).toBe('https://example.com/foo');
		expect(back.productSet).toBeInstanceOf(Set);
		expect(back.productSet.size).toBe(2);
		expect([...back.productSet][0]).toBeInstanceOf(Product);
		expect([...back.productSet][0].price).toBe(10);
	});

	test('invalid URL deserialization throws TYPE_MISMATCH', () => {
		expect(() => deserialize(CollectionsTest, { url: 'not-a-valid-url', productSet: [] })).toThrow(SerializationError);
	});

	test('invalid Set deserialization throws NOT_AN_ARRAY', () => {
		expect(() => deserialize(CollectionsTest, { url: 'https://example.com', productSet: {} })).toThrow(SerializationError);
	});

	@Serializable()
	class NamingStrategyTest {
		@JSONProperty()
		firstName!: string;

		@JSONProperty()
		lastName!: string;

		@JSONProperty({ name: 'OVERRIDDEN' })
		customName!: string;
	}

	test('naming strategies transform keys securely during deserialization', () => {
		const payload = {
			first_name: 'John',
			last_name: 'Doe',
			OVERRIDDEN: 'Yes'
		};

		const inst = deserialize(NamingStrategyTest, payload, '$', { namingStrategy: NamingStrategies.camelToSnake });
		expect(inst.firstName).toBe('John');
		expect(inst.lastName).toBe('Doe');
		expect(inst.customName).toBe('Yes');
	});

	test('naming strategies transform keys reliably during serialization', () => {
		const inst = new NamingStrategyTest();
		inst.firstName = 'Jane';
		inst.lastName = 'Smith';
		inst.customName = 'Indeed';

		const plain = serialize(inst, '$', { namingStrategy: NamingStrategies.camelToSnake });
		expect(plain).toEqual({
			first_name: 'Jane',
			last_name: 'Smith',
			OVERRIDDEN: 'Indeed'
		});
	});

	@Serializable()
	class AccountProfile {
		@JSONProperty()
		displayName!: string;
	}

	@Serializable()
	class Account {
		@JSONProperty({ type: () => AccountProfile })
		profile!: AccountProfile;
	}

	test('naming strategy applies to nested objects', () => {
		const payload = {
			profile: { display_name: 'Alice' }
		};

		const inst = deserialize(Account, payload, '$', { namingStrategy: NamingStrategies.camelToSnake });
		expect(inst.profile.displayName).toBe('Alice');
	});
});

// defaults/optional/nullable/validation
@Serializable()
class Settings {
	@JSONProperty({ defaultValue: 'light' })
	theme!: string;

	@JSONProperty({ defaultValue: () => [] })
	tags!: string[];

	@JSONProperty({ optional: false })
	required!: number;

	@JSONProperty({ nullable: 'error' })
	notNull!: string | null;
}

describe('defaults/required/nullable/validation', () => {
	test('defaults applied and required enforced', () => {
		const s = deserialize(Settings, { required: 1, notNull: 'x' });
		expect(s.theme).toBe('light');
		expect(s.tags).toEqual([]);
		expect(() => deserialize(Settings, { notNull: 'x' })).toThrow(SerializationError);
	});

	test('nullable error behaviour', () => {
		expect(() => deserialize(Settings, { required: 2, notNull: null })).toThrow(SerializationError);
	});

	@Serializable()
	class Positive {
		@JSONProperty({ validate: (v: number) => v > 0 || 'must be >0' })
		value!: number;
	}

	test('validation function', () => {
		expect(() => deserialize(Positive, { value: -1 })).toThrow(SerializationError);
	});

	@Serializable()
	class TransformOptional {
		@JSONProperty({
			optional: true,
			serializeTransform: (v: { data: string }) => v.data,
		})
		obj?: { data: string };
	}

	test('serializeTransform is bypassed when optional property is undefined', () => {
		const t = new TransformOptional();
		// Should not throw TypeError: Cannot read properties of undefined (reading 'data')
		const plain = serialize(t);
		expect(plain).toEqual({});
	});
});

// discriminator tests
// declare the base class first without decorators
class Shape {
	@JSONProperty()
	type!: string;
	@JSONProperty()
	color!: string;
}

@Serializable()
class Circle extends Shape {
	@JSONProperty()
	radius!: number;
}

@Serializable()
class Rectangle extends Shape {
	@JSONProperty()
	width!: number;
}

// now apply serialization-related decorators to Shape after subclasses exist
Serializable()(Shape);
JSONDiscriminator('type')(Shape);
JSONSubType('circle', Circle)(Shape);
JSONSubType('rect', Rectangle)(Shape);

describe('polymorphic deserialization', () => {
	test('dispatches to correct subtype', () => {
		const raw = { type: 'circle', color: 'red', radius: 5 };
		const s = deserialize(Shape, raw);
		expect(s).toBeInstanceOf(Circle);
		expect(s).toEqual(Object.assign(new Circle(), raw));
	});

	test('invalid discriminator value throws', () => {
		expect(() => deserialize(Shape, { type: 'triangle' } as any)).toThrow(SerializationError);
	});

	@Serializable()
	class Drawing {
		@JSONProperty({ type: () => Shape, isArray: true })
		shapes!: Shape[];
	}

	test('strict mode applies inside discriminator-dispatched nested objects', () => {
		expect(() => deserialize(Drawing, {
			shapes: [{ type: 'circle', color: 'red', radius: 5, extra: true }]
		}, '$', { strict: true })).toThrow(SerializationError);
	});
});

// miscellaneous behaviours
// undecorated objects now throw during serialization
describe('miscellaneous behaviours', () => {
	test('serializing plain object throws', () => {
		expect(() => serialize({ foo: 1 } as any)).toThrow(SerializationError);
	});

	test('clone creates deep copy', () => {
		const u = new User();
		u.firstName = 'foo';
		u.age = 3;
		const c = clone(User, u);
		expect(c).toEqual(u);
		expect(c).not.toBe(u);
	});

	test('patch merges partial updates', () => {
		const u = new User();
		u.firstName = 'Alice';
		u.age = 25;
		const updated = patch(User, u, { age: 26 });
		expect(updated.firstName).toBe('Alice');
		expect(updated.age).toBe(26);
		expect(updated).not.toBe(u); // returns new instance
	});

	test('patch accepts property keys for renamed JSON fields', () => {
		const u = new User();
		u.firstName = 'Alice';
		u.age = 25;

		const updated = patch(User, u, { firstName: 'Eve' });
		expect(updated.firstName).toBe('Eve');
		expect(updated.age).toBe(25);
	});
});

// Enums

enum StringStatus {
	Active = 'ACTIVE',
	Inactive = 'INACTIVE',
	Pending = 'PENDING'
}

enum NumericPriority {
	Low = 0,
	Medium = 1,
	High = 2
}

enum HeterogeneousKind {
	Success = 'SUCCESS',
	Failed = 1,
	Warning = 'WARNING'
}

@Serializable()
class Task {
	@JSONProperty()
	title!: string;

	@JSONProperty({ type: () => StringStatus })
	status!: StringStatus;

	@JSONProperty({ type: () => NumericPriority })
	priority!: NumericPriority;

	@JSONProperty({ type: () => HeterogeneousKind, optional: true })
	kind?: HeterogeneousKind;
}

@Serializable()
class TaskList {
	@JSONProperty({ type: () => Task, isArray: true })
	tasks!: Task[];

	@JSONProperty({ type: () => StringStatus, isMap: true })
	statusLookup!: Map<string, StringStatus>;
}

describe('enum support', () => {
	test('string enum deserializes and serializes', () => {
		const raw = { title: 'Fix bug', status: 'ACTIVE', priority: 1 };
		const task = deserialize(Task, raw);
		expect(task.status).toBe(StringStatus.Active);
		expect(task.priority).toBe(NumericPriority.Medium);
		expect(serialize(task)).toEqual(raw);
	});

	test('numeric enum round-trips', () => {
		const task = new Task();
		task.title = 'Test';
		task.status = StringStatus.Pending;
		task.priority = NumericPriority.High;
		const plain = serialize(task);
		expect(plain.priority).toBe(2);
		const back = deserialize(Task, plain);
		expect(back.priority).toBe(NumericPriority.High);
	});

	test('heterogeneous enum works', () => {
		const raw = { title: 'Task', status: 'ACTIVE', priority: 0, kind: 'SUCCESS' };
		const task = deserialize(Task, raw);
		expect(task.kind).toBe(HeterogeneousKind.Success);
		expect(serialize(task)).toEqual(raw);
	});

	test('heterogeneous numeric enum value', () => {
		const raw = { title: 'Task', status: 'ACTIVE', priority: 0, kind: 1 };
		const task = deserialize(Task, raw);
		expect(task.kind).toBe(HeterogeneousKind.Failed);
		expect(serialize(task)).toEqual(raw);
	});

	test('invalid enum value throws', () => {
		expect(() => deserialize(Task, { title: 'Task', status: 'INVALID', priority: 0 })).toThrow(SerializationError);
	});

	test('reverse mapping enum string keys are rejected for numeric enums', () => {
		expect(() => deserialize(Task, { title: 'Task', status: 'ACTIVE', priority: 'Low' } as any)).toThrow(SerializationError);
	});

	test('enum in array', () => {
		const raw = {
			tasks: [
				{ title: 'Task 1', status: 'ACTIVE', priority: 0 },
				{ title: 'Task 2', status: 'PENDING', priority: 2 }
			],
			statusLookup: { active: 'ACTIVE', pending: 'PENDING' }
		};
		const list = deserialize(TaskList, raw);
		expect(list.tasks[0].status).toBe(StringStatus.Active);
		expect(list.tasks[1].status).toBe(StringStatus.Pending);
		expect(serialize(list)).toEqual(raw);
	});

	test('enum in map', () => {
		const raw = {
			tasks: [],
			statusLookup: { a: 'ACTIVE', b: 'INACTIVE' }
		};
		const list = deserialize(TaskList, raw);
		expect(list.statusLookup.get('a')).toBe(StringStatus.Active);
		expect(list.statusLookup.get('b')).toBe(StringStatus.Inactive);
		expect(serialize(list)).toEqual(raw);
	});

	test('invalid enum in array throws', () => {
		expect(() => deserialize(TaskList, {
			tasks: [{ title: 'Task', status: 'NOPE', priority: 0 }],
			statusLookup: {}
		})).toThrow(SerializationError);
	});

	test('isEnum detects enums', () => {
		expect(isEnum(StringStatus)).toBe(true);
		expect(isEnum(NumericPriority)).toBe(true);
		expect(isEnum(HeterogeneousKind)).toBe(true);
		expect(isEnum({ foo: 'bar' })).toBe(false);
		expect(isEnum(Task)).toBe(false);
		expect(isEnum([])).toBe(false);
		expect(isEnum(null)).toBe(false);
	});

	test('enum with toJSON/fromJSON', () => {
		const task = new Task();
		task.title = 'Test';
		task.status = StringStatus.Active;
		task.priority = NumericPriority.High;
		const json = toJSON(task);
		const back = fromJSON(Task, json);
		expect(back.status).toBe(StringStatus.Active);
		expect(back.priority).toBe(NumericPriority.High);
	});

	test('enum clone preserves values', () => {
		const task = new Task();
		task.title = 'Original';
		task.status = StringStatus.Inactive;
		task.priority = NumericPriority.Low;
		const cloned = clone(Task, task);
		expect(cloned.status).toBe(StringStatus.Inactive);
		expect(cloned.priority).toBe(NumericPriority.Low);
	});
});

// additional tests for caching/performance helpers

describe('internal caches', () => {
	test('isEnum caches result', () => {
		// use a brand‑new enum object so the cache is initially empty
		enum Local { A = 'A', B = 'B' }
		expect(__test_enumIsCached(Local)).toBe(false);
		expect(isEnum(Local)).toBe(true);
		expect(__test_enumIsCached(Local)).toBe(true);
		// second call still returns true and doesn't blow up
		expect(isEnum(Local)).toBe(true);
	});

	test('getEnumValues caches values array', () => {
		const first = getEnumValues(NumericPriority);
		const second = getEnumValues(NumericPriority);
		expect(first).toBe(second); // same reference means it came from cache
		expect(__test_cachedValues(NumericPriority)).toBe(second);
	});
});

// verify primitive coercion error path still works
@Serializable()
class CoerceTest {
	@JSONProperty({ type: Number })
	val!: number;
}

@Serializable()
class BooleanCoerceTest {
	@JSONProperty({ type: Boolean })
	val!: boolean;
}

describe('primitive coercion', () => {
	test('invalid number throws with correct path', () => {
		expect(() => deserialize(CoerceTest, { val: 'NaN' })).toThrow(SerializationError);
	});

	test('boolean coercion accepts explicit boolean-like values', () => {
		expect(deserialize(BooleanCoerceTest, { val: true }).val).toBe(true);
		expect(deserialize(BooleanCoerceTest, { val: false }).val).toBe(false);
		expect(deserialize(BooleanCoerceTest, { val: 'true' }).val).toBe(true);
		expect(deserialize(BooleanCoerceTest, { val: 'false' }).val).toBe(false);
		expect(deserialize(BooleanCoerceTest, { val: 1 }).val).toBe(true);
		expect(deserialize(BooleanCoerceTest, { val: 0 }).val).toBe(false);
	});

	test('boolean coercion rejects ambiguous truthy/falsy values', () => {
		expect(() => deserialize(BooleanCoerceTest, { val: '0' })).toThrow(SerializationError);
		expect(() => deserialize(BooleanCoerceTest, { val: 'yes' })).toThrow(SerializationError);
		expect(() => deserialize(BooleanCoerceTest, { val: 2 })).toThrow(SerializationError);
	});
});

// error code tests
@Serializable()
class Required {
	@JSONProperty({ optional: false })
	field!: string;
}

describe('error codes', () => {
	test('MISSING_PROPERTY code on required field', () => {
		try {
			deserialize(Required, {});
			expect.fail('should throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SerializationError);
			expect((e as SerializationError).code).toBe(SerializationErrorCode.MISSING_PROPERTY);
		}
	});

	test('INVALID_ENUM_VALUE code on invalid enum', () => {
		try {
			deserialize(Task, { title: 'X', status: 'INVALID', priority: 0 });
			expect.fail('should throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SerializationError);
			expect((e as SerializationError).code).toBe(SerializationErrorCode.INVALID_ENUM_VALUE);
		}
	});

	test('UNEXPECTED_PROPERTY code in strict mode', () => {
		try {
			deserialize(User, { first_name: 'Ada', age: 30, extra: true }, '$', { strict: true });
			expect.fail('should throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SerializationError);
			expect((e as SerializationError).code).toBe(SerializationErrorCode.UNEXPECTED_PROPERTY);
		}
	});

	test('NULL_NOT_ALLOWED code when nullable: error', () => {
		@Serializable()
		class StrictNull {
			@JSONProperty({ nullable: 'error' })
			val!: string;
		}

		try {
			deserialize(StrictNull, { val: null });
			expect.fail('should throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SerializationError);
			expect((e as SerializationError).code).toBe(SerializationErrorCode.NULL_NOT_ALLOWED);
		}
	});

	test('VALIDATION_FAILED code on failed validation', () => {
		@Serializable()
		class ValidatedNum {
			@JSONProperty({ validate: (v: number) => v > 0 })
			num!: number;
		}

		try {
			deserialize(ValidatedNum, { num: -5 });
			expect.fail('should throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SerializationError);
			expect((e as SerializationError).code).toBe(SerializationErrorCode.VALIDATION_FAILED);
		}
	});
});
