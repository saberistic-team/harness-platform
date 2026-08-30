/**
 * Scenario DSL — M2: the source of truth moved to @harness/sdk
 * (packages/sdk/src/scenario-dsl.ts) so the DSL is one vocabulary
 * shared by evals, the exit gate, and (in M3+) the services. This
 * file keeps the runner's import surface stable.
 */
export {
  runStatusSchema,
  eventInvariantSchema,
  runExpectSchema,
  scenarioExpectSchema,
  scenarioSchema,
  ScenarioParseError,
  decodeScenario,
  loadScenario,
  toEventInvariant,
} from "@harness/sdk";
export type {
  EventInvariant,
  RunStatus,
  ScenarioExpect,
  Scenario,
} from "@harness/sdk";
