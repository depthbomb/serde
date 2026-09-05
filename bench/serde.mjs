import { cpus } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const modulePath                                                                               = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../dist/index.mjs'));
const { Serializable, JSONProperty, serialize, serializeAsync, deserialize, deserializeAsync } = await import(pathToFileURL(modulePath));
let conversionCount                                                                            = 0;

class Flat {}
class Item {}
class Order {}
class Chain {}
class CountedChain {}

for (const ctor of [Flat, Item, Order, Chain, CountedChain]) {
	Serializable()(ctor);
}

for (const key of ['id', 'name', 'email', 'age', 'active', 'city', 'country', 'score']) {
	JSONProperty()(Flat.prototype, key);
}

JSONProperty({
	type: String,
})(Item.prototype, 'sku');
JSONProperty({
	type: Number,
})(Item.prototype, 'quantity');
JSONProperty({
	type: Number,
})(Item.prototype, 'price');
JSONProperty({
	type: Date,
})(Item.prototype, 'created');
JSONProperty()(Order.prototype, 'id');
JSONProperty({
	type:    Item,
	isArray: true,
})(Order.prototype, 'items');
JSONProperty({
	type:  Number,
	isMap: true,
})(Order.prototype, 'totals');
JSONProperty()(Chain.prototype, 'value');
JSONProperty({
	type: Chain,
})(Chain.prototype, 'child');
JSONProperty({
	serializeTransform: value => {
		conversionCount++;

		return value;
	},
})(CountedChain.prototype, 'value');
JSONProperty({
	type: CountedChain,
})(CountedChain.prototype, 'child');


const flat = Object.assign(new Flat(), {
	id:      1,
	name:    'Ada',
	email:   'ada@example.com',
	age:     36,
	active:  true,
	city:    'London',
	country: 'GB',
	score:   42,
});
const order = Object.assign(new Order(), {
	id:     17,
	items:  Array.from({
		length: 20,
	}, (_, index) => Object.assign(new Item(), {
		sku:      `sku-${index}`,
		quantity: index + 1,
		price:    12.5,
		created:  new Date('2026-09-01T12:00:00Z'),
	})),
	totals: new Map([['subtotal', 2625], ['tax', 210]]),
});

function makeChain(ctor, depth) {
	let child;
	for (let value = 0; value < depth; value++) {
		child = Object.assign(new ctor(), {
			value,
			...(child ? {
				child,
			} : {}),
		});
	}

	return child;
}

async function benchmark(name, operation, isAsync) {
	for (let index = 0; index < 100; index++) {
		if (isAsync) {
			await operation();
		} else {
			operation();
		}
	}

	const samples = [];
	for (let sample = 0; sample < 5; sample++) {
		let count     = 0;
		const started = performance.now();
		let elapsed;
		do {
			for (let batch = 0; batch < 20; batch++) {
				if (isAsync) {
					await operation();
				} else {
					operation();
				}
			}
			count += 20;
			elapsed = performance.now() - started;
		} while (elapsed < 100);
		samples.push(elapsed * 1000 / count);
	}
	samples.sort((left, right) => left - right);
	console.log(JSON.stringify({
		name,
		medianUs: Number(samples[2].toFixed(3)),
		minUs:    Number(samples[0].toFixed(3)),
		maxUs:    Number(samples[4].toFixed(3)),
	}));
}

console.log(JSON.stringify({
	modulePath,
	node:            process.version,
	cpu:             cpus()[0].model,
	platform:        process.platform,
	samples:         5,
	minimumSampleMs: 100,
}));

for (const depth of [32, 64, 128, 256]) {
	const value       = makeChain(CountedChain, depth);
	conversionCount   = 0;
	const sync        = serialize(value);
	const syncCount   = conversionCount;
	conversionCount   = 0;
	const asyncResult = await serializeAsync(value);
	assert.deepEqual(asyncResult, sync);
	console.log(JSON.stringify({
		depth,
		syncConversions:  syncCount,
		asyncConversions: conversionCount,
	}));
}

for (const [name, ctor, value] of [['flat8', Flat, flat], ['order20', Order, order]]) {
	const raw = serialize(value);
	assert.deepEqual(await serializeAsync(value), raw);
	assert.deepEqual(await deserializeAsync(ctor, raw), deserialize(ctor, raw));
	await benchmark(`${name} serialize`, () => serialize(value), false);
	await benchmark(`${name} serializeAsync`, () => serializeAsync(value), true);
	await benchmark(`${name} deserialize`, () => deserialize(ctor, raw), false);
	await benchmark(`${name} deserializeAsync`, () => deserializeAsync(ctor, raw), true);
}

for (const depth of [64, 128, 256]) {
	const value = makeChain(Chain, depth);
	await benchmark(`chain${depth} serialize`, () => serialize(value), false);
	await benchmark(`chain${depth} serializeAsync`, () => serializeAsync(value), true);
}
