import { describe, it, expect, afterEach } from "vitest";
import {
  createHarnessTelemetry,
  telemetryFromEnv,
  type HarnessTelemetry,
} from "../src/index";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import {
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { AnyHarnessEvent } from "@harness/events";
import { runAgent } from "@harness/kernel";
import { FakeModel } from "@harness/models";
import { createTool, ToolRegistry } from "@harness/tools";
import { z } from "zod";

interface MetricLike {
  name?: string;
  descriptor?: { name: string };
  dataPoints?: { value: unknown }[];
}

function metricName(m: MetricLike): string {
  return m.name ?? m.descriptor?.name ?? "<unknown>";
}

interface TelemetryFixture {
  t: HarnessTelemetry;
  spans: ReadableSpan[];
  metricExporter: InMemoryMetricExporter;
}

const finished: HarnessTelemetry[] = [];

async function makeTelemetry(): Promise<TelemetryFixture> {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    // Long interval: we flush explicitly via provider.forceFlush().
    exportIntervalMillis: 3_600_000,
  });
  const t = await createHarnessTelemetry({
    serviceName: "harness-test",
    exporter: spanExporter,
    metricReader,
  });
  finished.push(t);
  return {
    t,
    spans: spanExporter.getFinishedSpans(),
    metricExporter,
  };
}

afterEach(async () => {
  await Promise.all(finished.splice(0).map((t) => t.shutdown()));
});

/** Drive the GOLDEN KERNEL (same shape as the eval runner) and feed
 *  every stream event to the bridge: kernel -> bridge -> sink. */
async function runKernelThroughBridge(
  fx: TelemetryFixture,
  scripted: ConstructorParameters<typeof FakeModel>[0],
  tools?: ToolRegistry,
) {
  const model = new FakeModel(scripted);
  return runAgent({
    goal: "echo hi",
    model,
    tools,
    taskId: "kernel-0001",
    sessionId: "sess-otel-1",
    now: () => "2026-01-01T00:00:00.000Z",
    newId: (p) => `${p}-n`,
    onEvent: (e: AnyHarnessEvent) => fx.t.bridge.onEvent(e),
  });
}

describe("OTel bridge: harness events -> spans + metrics", () => {
  it("produces a run span, per-model spans, per-tool spans", async () => {
    const fx = await makeTelemetry();
    const add = createTool({
      name: "echo",
      description: "echo a string",
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => `echo:${text}`,
    });
    const result = await runKernelThroughBridge(
      fx,
      [
        { content: "", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hi" } }] },
        { content: "done!" },
      ],
      new ToolRegistry([add]),
    );
    expect(result.text).toBe("done!");

    const names = fx.spans.map((s) => s.name);
    expect(names).toContain("harness.session");
    expect(names.filter((n) => n === "harness.model.request")).toHaveLength(2);
    expect(names).toContain("harness.tool.call");
    expect(fx.spans).toHaveLength(4); // session + 2 model + 1 tool

    const session = fx.spans.find((s) => s.name === "harness.session")!;
    expect(session.attributes["harness.session.id"]).toBe("sess-otel-1");
    expect(session.attributes["harness.task.id"]).toBe("kernel-0001");
    expect(session.attributes["harness.model"]).toBe("fake-model/v1");
    expect(session.attributes["harness.status"]).toBe("completed");
    expect(session.attributes["harness.steps"]).toBe(2);
    expect(session.attributes["harness.tool_calls"]).toBe(1);
    expect(session.status.code).toBe(1); // SpanStatusCode.OK (0=UNSET 2=ERROR)

    const toolSpan = fx.spans.find((s) => s.name === "harness.tool.call")!;
    expect(toolSpan.attributes["harness.tool"]).toBe("echo");
    expect(toolSpan.attributes["harness.ok"]).toBe(true);
    expect(toolSpan.status.code).toBe(0); // SpanStatusCode.UNSET (success by default)

    // All spans of the run share one trace.
    const runTrace = session.spanContext().traceId;
    const modelSpan = fx.spans.find((s) => s.name === "harness.model.request")!;
    expect(modelSpan.spanContext().traceId).toBe(runTrace);
    const toolSpan2 = fx.spans.find((s) => s.name === "harness.tool.call")!;
    expect(toolSpan2.spanContext().traceId).toBe(runTrace);
  });

  it("records failing tool results as ERROR spans (unknown tool)", async () => {
    const fx = await makeTelemetry();
    await runKernelThroughBridge(fx, [
      { content: "", toolCalls: [{ id: "c1", name: "missing-tool", arguments: {} }] },
      { content: "sad" },
    ]);

    const toolSpan = fx.spans.find((s) => s.name === "harness.tool.call")!;
    expect(toolSpan.attributes["harness.tool"]).toBe("missing-tool");
    expect(toolSpan.attributes["harness.ok"]).toBe(false);
    expect(toolSpan.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("fails a failing run's session span with ERROR", async () => {
    const fx = await makeTelemetry();
    // maxSteps exhausted => agent.stopped status "failed".
    const model = new FakeModel([
      { content: "", toolCalls: [{ id: "a", name: "spin", arguments: {} }] },
      { content: "", toolCalls: [{ id: "b", name: "spin", arguments: {} }] },
    ]);
    await runAgent({
      goal: "spin",
      model,
      maxSteps: 2,
      sessionId: "sess-otel-3",
      now: () => "2026-01-01T00:00:00.000Z",
      newId: (p) => `${p}-n`,
      onEvent: (e) => fx.t.bridge.onEvent(e),
    });
    const session = fx.spans.find((s) => s.name === "harness.session")!;
    expect(session.attributes["harness.status"]).toBe("failed");
    expect(session.status.code).toBe(2);
  });

  it("counts model turns, tokens, and tool calls as metrics", async () => {
    const fx = await makeTelemetry();
    const bump = createTool({
      name: "bump",
      description: "bump",
      parameters: z.object({ by: z.number() }),
      execute: ({ by }) => by,
    });
    await runAgent({
      goal: "count",
      model: new FakeModel([
        { content: "", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, toolCalls: [{ id: "c1", name: "bump", arguments: { by: 1 } }] },
        { content: "done", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
      ]),
      tools: new ToolRegistry([bump]),
      taskId: "kernel-0001",
      sessionId: "sess-otel-4",
      now: () => "2026-01-01T00:00:00.000Z",
      newId: (p) => `${p}-n`,
      onEvent: (e) => fx.t.bridge.onEvent(e),
    });

    await fx.t.forceFlush();
    const last = fx.metricExporter.getMetrics();
    const resourceMetrics = Array.isArray(last) ? last : [last].filter(Boolean);
    const flat: Record<string, number> = {};
    for (const rm of resourceMetrics) {
      for (const scope of (rm as { scopeMetrics?: Array<{ metrics?: MetricLike[] }> }).scopeMetrics ?? []) {
        for (const m of scope.metrics ?? []) {
          const sum = (m.dataPoints ?? []).reduce(
            (acc: number, dp: { value: unknown }) => acc + Number(dp.value),
            0,
          );
          flat[metricName(m)] = (flat[metricName(m)] ?? 0) + sum;
        }
      }
    }
    expect(flat["harness.model.turns"]).toBe(2);
    expect(flat["harness.model.tokens"]).toBe(45);
    expect(flat["harness.tool.calls"]).toBe(1);
  });

  it("telemetryFromEnv: off by default, on with HARNESS_OTEL or an endpoint", () => {
    expect(telemetryFromEnv({})).toBeNull();
    expect(telemetryFromEnv({ HARNESS_OTEL: "1" })).toEqual({
      serviceName: undefined,
      otlpEndpoint: undefined,
      forceConsole: false,
    });
    expect(
      telemetryFromEnv({ OTEL_EXPORT_OTLP_ENDPOINT: "http://127.0.0.1:4318" }),
    ).toMatchObject({ otlpEndpoint: "http://127.0.0.1:4318" });
    expect(telemetryFromEnv({ OTEL_TRACES_EXPORTER: "console" })).toMatchObject({
      forceConsole: true,
    });
  });
});
