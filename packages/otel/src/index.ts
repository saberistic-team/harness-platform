/**
 * @harness/otel — OpenTelemetry wiring for the harness (ROADMAP M2).
 *
 * kernel (events) -> EventBridge (spans + metrics) -> local collector
 * (OTLP/HTTP; console sink when no endpoint; in-memory test seam).
 *
 * See src/telemetry.ts for the pipeline and the env-var contract.
 */
export {
  createHarnessTelemetry,
  telemetryFromEnv,
  type TelemetryKind,
  type TelemetryOptions,
  type HarnessTelemetry,
} from "./telemetry";
export { EventBridge } from "./bridge";
export type { AnyHarnessEvent } from "./bridge";
