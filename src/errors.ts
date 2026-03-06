export class SerializationError extends Error {
	public readonly path: string;

	public constructor(message: string, path: string, cause?: unknown) {
		super(`[@depthbomb/serde] ${message} (at "${path}")`);

		this.name  = 'SerializationError';
		this.cause = cause;
		this.path  = path;
	}
}
