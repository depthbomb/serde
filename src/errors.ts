/** Error codes for SerializationError enabling type-safe error handling */
export enum SerializationErrorCode {
	/** Input or instance is null/undefined when it shouldn't be */
	NULL_INPUT = 'NULL_INPUT',
	/** A required property is missing from the input */
	MISSING_PROPERTY = 'MISSING_PROPERTY',
	/** A property value is null when nullable: 'error' is set */
	NULL_NOT_ALLOWED = 'NULL_NOT_ALLOWED',
	/** A value doesn't match the expected type (mismatch, invalid enum, etc.) */
	TYPE_MISMATCH = 'TYPE_MISMATCH',
	/** A discriminator value doesn't map to a known subtype */
	UNKNOWN_DISCRIMINATOR = 'UNKNOWN_DISCRIMINATOR',
	/** An enum value is invalid */
	INVALID_ENUM_VALUE = 'INVALID_ENUM_VALUE',
	/** Custom validation function returned false or error string */
	VALIDATION_FAILED = 'VALIDATION_FAILED',
	/** Strict mode rejected an unexpected property */
	UNEXPECTED_PROPERTY = 'UNEXPECTED_PROPERTY',
	/** Class was not decorated with @Serializable */
	UNMARKED_CLASS = 'UNMARKED_CLASS',
	/** Input is not an array when array is expected */
	NOT_AN_ARRAY = 'NOT_AN_ARRAY',
}

export class SerializationError extends Error {
	public readonly path: string;
	public readonly code: SerializationErrorCode;

	public constructor(message: string, path: string, code: SerializationErrorCode = SerializationErrorCode.TYPE_MISMATCH, cause?: unknown) {
		super(`[@depthbomb/serde] ${message} (at "${path}")`);

		this.name  = 'SerializationError';
		this.code  = code;
		this.cause = cause;
		this.path  = path;
	}
}
