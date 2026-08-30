import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { Meter, Tracer } from "@opentelemetry/api";
import { EventBridge } from "./bridge";

/**
 * OpenTelemetry wiring (ROADMAP M2: "kernel -> CLI -> local collector").
 *
 * How the pipeline fits the repo:
 *  - the GOLDEN KERNEL (packages/kernel) emits @harness/events events;
 *  - the eval runner and the CLI each hand that SAME stream to
 *    EventBridge, so kernel and CLI speak one telemetry dialect;
 *  - this module assembles the providers and chooses the sink:
 *      OTEL_EXPORT_OTLP_ENDPOINT set -> OTLP/HTTP to the local
 *        collector (infra/otel-collector, port 4318 by convention)
 *      else                          -> ConsoleSpanExporter (stdout),
 *                                        which is the "local collector"
 *                                        for a laptop and keeps tests
 *                                        deterministic
 *      injected exporter/reader      -> test seam (InMemory*).
 *
 * Rule 7 holds: with no env config and an injected exporter, nothing
 * here touches the network.
 */

export type TelemetryKind = "otlp" | "console" | "injected";

export interface TelemetryOptions {
  /** service.name resource attribute (default "harness"). */
  serviceName?: string;
  /** Test seam: e.g. InMemorySpanExporter. Implies "injected". */
  exporter?: SpanExporter;
  /** Test seam: e.g. InMemoryMetricReader. Implies "injected". */
  metricReader?: MetricReader;
  /** OTLP/HTTP collector base URL, e.g. http://127.0.0.1:4318. */
  otlpEndpoint?: string;
  /** Force the stdout sink regardless of endpoints. */
  forceConsole?: boolean;
}

export interface HarnessTelemetry {
  kind: TelemetryKind;
  tracer: Tracer;
  meter: Meter;
  bridge: EventBridge;
  /** Push pending metrics into the reader's sink (flush before reads). */
  forceFlush(): Promise<void>;
  /** Flush + shut down providers. Call before the process exits. */
  shutdown(): Promise<void>;
}

/**
 * Read the OTel configuration out of the environment (OTEL_* are the
 * spec's knobs; HARNESS_OTEL is the on/off switch). Returns null when
 * telemetry is off — the caller then runs with zero OTel involvement.
 */
export function telemetryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryOptions | null {
  const explicitOn = env.HARNESS_OTEL === "1" || env.HARNESS_OTEL === "true";
  const endpoint = (env.OTEL_EXPORT_OTLP_ENDPOINT ?? "").trim();
  const forceConsole = env.OTEL_TRACES_EXPORTER === "console" && !endpoint;
  if (!explicitOn && !endpoint && !forceConsole) return null;
  return {
    serviceName: env.OTEL_SERVICE_NAME?.trim() || undefined,
    otlpEndpoint: endpoint || undefined,
    forceConsole,
  };
}

function resolveSink(
  opts: TelemetryOptions,
): { kind: TelemetryKind; exporter: SpanExporter; processorConstructor: (e: SpanExporter) => SimpleSpanProcessor | BatchSpanProcessor } {
  if (opts.exporter || opts.metricReader) {
    // Test seam takes priority: deterministic, in-memory, offline.
    const exporter =
      opts.exporter ??
      new ConsoleSpanExporter();
    return {
      kind: "injected",
      exporter,
      processorConstructor: (e) => new SimpleSpanProcessor(e),
    };
  }
  if (opts.otlpEndpoint && !opts.forceConsole) {
    const url = opts.otlpEndpoint.replace(/\/$/, "");
    return {
      kind: "otlp",
      exporter: new OTLPTraceExporter({ url: `${url}/v1/traces` }),
      processorConstructor: (e) => new BatchSpanProcessor(e),
    };
  }
  return {
    kind: "console",
    exporter: new ConsoleSpanExporter(),
    processorConstructor: (e) => new SimpleSpanProcessor(e),
  };
}

async function createHarnessTelemetry(
  opts: TelemetryOptions = {},
): Promise<HarnessTelemetry> {
  const serviceName = opts.serviceName ?? "harness";
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": "0.0.0",
    "harness.runtime": "node",
  });

  const sink = resolveSink(opts);
  const processor = sink.processorConstructor(sink.exporter);
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [processor],
  });
  provider.register();
  const tracer = provider.getTracer(`harness.${serviceName}`);

  let meterProvider: MeterProvider;
  if (opts.metricReader) {
    meterProvider = new MeterProvider({
      resource,
      readers: [opts.metricReader],
    });
  } else if (sink.kind === "otlp") {
    const url = (opts.otlpEndpoint as string).replace(/\/$/, "");
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${url}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        }),
      ],
    });
  } else {
    // No OTLP endpoint: metrics have no sink (a periodic console
    // exporter would spam). Counters are still exposed for the
    // injected/console test seams, which never touch the network.
    meterProvider = new MeterProvider({ resource });
  }
  const meter = meterProvider.getMeter(`harness.${serviceName}`);

  const bridge = new EventBridge(tracer, meter);

  return {
    kind: sink.kind,
    tracer,
    meter,
    bridge,
    forceFlush: () => meterProvider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

export { createHarnessTelemetry };
