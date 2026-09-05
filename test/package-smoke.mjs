import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'serde-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (args, options) => process.platform === 'win32'
	? execFileSync('cmd.exe', ['/d', '/s', '/c', npm, ...args], options)
	: execFileSync(npm, args, options);

try {
	const packOutput = runNpm(['pack', root, '--json', '--pack-destination', temporary], {
		cwd: temporary,
		encoding: 'utf8',
	});
	const [{ filename }] = JSON.parse(packOutput);
	const tarball = join(temporary, filename);
	runNpm(['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
		cwd: temporary,
		stdio: 'pipe',
	});

	writeFileSync(join(temporary, 'consumer.mts'), `
import { JSONProperty, Serializable, serialize, toJSON, fromJSON, clone, patch, toJSONAsync, fromJSONAsync, SerializationError, type Constructor } from '@depthbomb/serde';
import { SerializationError as SubpathError } from '@depthbomb/serde/errors';
import { toJSON as subpathToJSON } from '@depthbomb/serde/utilities';
class Consumer {
	public value!: string;
}
Serializable()(Consumer);
JSONProperty()(Consumer.prototype, 'value');
const ctor: Constructor<Consumer> = Consumer;
const value = Object.assign(new ctor(), {
	value: 'works',
});
if (toJSON !== subpathToJSON || SerializationError !== SubpathError) {
	throw new Error('Root and subpath exports differ');
}

if (toJSON(value) !== '{"value":"works"}' || serialize(value).value !== 'works') {
	throw new SerializationError('smoke failure', '$');
}

if (fromJSON(Consumer, toJSON(value)).value !== 'works' || clone(Consumer, value).value !== 'works') {
	throw new Error('Synchronous utility export failure');
}

if (patch(Consumer, value, {
	value: 'updated',
}).value !== 'updated') {
	throw new Error('Patch export failure');
}

if ((await fromJSONAsync(Consumer, await toJSONAsync(value))).value !== 'works') {
	throw new Error('Async utility export failure');
}
`);
	writeFileSync(join(temporary, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			strict: true,
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			target: 'ES2022',
			outDir: 'output',
			skipLibCheck: false,
		},
		include: ['consumer.mts'],
	}));

	execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
		cwd: temporary,
		stdio: 'inherit',
	});
	execFileSync(process.execPath, [join(temporary, 'output', 'consumer.mjs')], { cwd: temporary, stdio: 'inherit' });

	const manifest = JSON.parse(readFileSync(join(temporary, 'node_modules', '@depthbomb', 'serde', 'package.json'), 'utf8'));
	if (manifest.types !== './dist/index.d.mts') throw new Error('published types path is incorrect');
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
