export class HarnessError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The event wire type is not recognized by this platform version.
 * The full event is preserved on `.raw` for later migration.
 */
export class UnknownEventTypeError extends HarnessError {
  constructor(
    readonly type: string,
    readonly raw: unknown,
  ) {
    super(
      `Unknown event type: ${JSON.stringify(type)}`,
      "EVT_UNKNOWN_TYPE",
    );
  }
}

/**
 * The event envelope version is not supported by this platform version.
 * Thrown before payload validation, so old/future frames are not corrupted.
 */
export class EventVersionError extends HarnessError {
  constructor(
    readonly version: unknown,
    readonly raw: unknown,
  ) {
    super(
      `Unsupported event envelope version: ${JSON.stringify(version)}`,
      "EVT_UNSUPPORTED_VERSION",
    );
  }
}

/**
 * The event passed the version + type gates but fails its payload schema.
 */
export class EventSchemaError extends HarnessError {
  readonly issues: readonly { path: string; message: string }[];

  constructor(readonly type: string, issues: readonly { path: string; message: string }[]) {
    super(
      `Invalid payload for event type ${JSON.stringify(type)}: ${issues.length} issue(s)`,
      "EVT_BAD_PAYLOAD",
    );
    this.issues = issues;
  }
}

/**
 * The input was not valid JSON at all (parse failure).
 */
export class EventParseError extends HarnessError {
  constructor(message: string) {
    super(message, "EVT_BAD_JSON");
  }
}
