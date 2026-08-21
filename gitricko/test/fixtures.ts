/**
 * Fault-injection test fixtures for pi-failover.
 *
 * This file defines:
 *  - A fake provider matrix (primary/fallback models)
 *  - A "reference Hermes" controller that implements the textbook Hermes switch
 *  - The matrix of scenarios from ARCHITECTURE.md §6(C)
 *  - Assertions that `pi-failover` produces identical observables to the reference.
 *
 * Run with: `npm test` (uses tsx)
 */

import type { Model, Context, AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai";

// ============================================================================
// Fake models
// ============================================================================

const PRIMARY_MODEL: Model<any> = {
  id: "primary",
  provider: "primary",
  name: "Primary Model",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

const FALLBACK_MODEL: Model<any> = {
  id: "fallback",
  provider: "fallback",
  name: "Fallback Model",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

const SECONDARY_FALLBACK: Model<any> = {
  id: "fallback2",
  provider: "fallback",
  name: "Secondary Fallback",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

// ============================================================================
// Error classes (match Pi's error taxonomy)
// ============================================================================

class RetryableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RetryableError";
  }
}

class TerminalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TerminalError";
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// ============================================================================
// Fake stream builders
// ============================================================================

type Chunk = { type: "text"; text: string } | { type: "tool_use"; name: string; args: any } | { type: "finish"; reason: string };

function* makeStream(chunks: Chunk[], delayMs = 10) {
  for (const c of chunks) {
    yield new Promise((r) => setTimeout(() => r({ done: false, value: c }), delayMs));
  }
  yield { done: true, value: undefined };
}

function streamFrom(chunks: Chunk[], delayMs = 10): AssistantMessageEventStream {
  const gen = makeStream(chunks, delayMs);
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return gen.next().value;
        },
      };
    },
  };
}

// ============================================================================
// Reference Hermes controller (the "golden" behavior)
// ============================================================================

interface HermesResult {
  chunks: Chunk[];
  switched: boolean;
  from: string;
  to: string;
  error?: Error;
}

type StreamFn = (model: Model<any>, ctx: Context, opts: SimpleStreamOptions) => AssistantMessageEventStream;

/**
 * Textbook Hermes failover: on pre-first-token failure of primary,
 * re-issue the EXACT SAME REQUEST (ctx, opts) against the fallback chain.
 * This is the reference implementation that pi-failover must match byte-for-byte.
 */
async function hermesReference(
  primary: Model<any>,
  fallbacks: Model<any>[],
  primaryStreamFn: StreamFn,
  fallbackStreamFn: StreamFn,
  ctx: Context,
  opts: SimpleStreamOptions,
  timeoutMs: number,
): Promise<HermesResult> {
  const candidates = [primary, ...fallbacks];
  let lastError: Error | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const isPrimary = i === 0;

    try {
      const stream = isPrimary
        ? primaryStreamFn(model, ctx, opts)
        : fallbackStreamFn(model, ctx, opts);

      const chunks: Chunk[] = [];
      let firstToken = false;
      let timedOut = false;

      // Race: first token vs timeout
      const tokenPromise = (async () => {
        for await (const chunk of stream as any) {
          if (chunk.type === "text") firstToken = true;
          chunks.push(chunk);
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs),
      );

      await Promise.race([tokenPromise, timeoutPromise]);
      timedOut = !firstToken;

      return {
        chunks,
        switched: i > 0,
        from: primary.provider + "/" + primary.id,
        to: model.provider + "/" + model.id,
      };
    } catch (err) {
      lastError = err as Error;
      const timeout = err instanceof TimeoutError;
      const terminal = err instanceof TerminalError;
      const retryable = err instanceof RetryableError;

      // Hermes logic: timeout/terminal/network → try next; retryable → rethrow
      if (timeout || terminal || (err as any).code === "ECONNREFUSED") {
        continue;
      }
      if (retryable) {
        throw err;
      }
      // Unknown: conservative fail-over
      continue;
    }
  }

  return {
    chunks: [],
    switched: false,
    from: primary.provider + "/" + primary.id,
    to: "none",
    error: lastError,
  };
}

// ============================================================================
// Scenario matrix (§6(C))
// ============================================================================

interface Scenario {
  name: string;
  description: string;
  primary: (ctx: Context, opts: SimpleStreamOptions) => AssistantMessageEventStream;
  fallbacks: Array<(ctx: Context, opts: SimpleStreamOptions) => AssistantMessageEventStream>;
  // Expected outcome for BOTH hermesReference AND pi-failover
  expect: {
    switched: boolean;
    from: string;
    to: string;
    chunkTypes: string[]; // e.g. ["text", "text", "finish"]
    error?: string; // error name if all fail
  };
}

function primaryTimeout(fallbackDelay = 10): Scenario {
  return {
    name: "primary-timeout-fallback-ok",
    description: "Primary times out (no first token); fallback responds quickly.",
    primary: () => streamFrom([], 50_000), // slow (timeout will trigger)
    fallbacks: [() => streamFrom([{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }], fallbackDelay)],
    expect: {
      switched: true,
      from: "primary/primary",
      to: "fallback/fallback",
      chunkTypes: ["text", "finish"],
    },
  };
}

function primary500(): Scenario {
  return {
    name: "primary-500-fallback-ok",
    description: "Primary throws 500 (TerminalError); fallback succeeds.",
    primary: () => { throw new TerminalError("internal server error"); },
    fallbacks: [() => streamFrom([{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }])],
    expect: {
      switched: true,
      from: "primary/primary",
      to: "fallback/fallback",
      chunkTypes: ["text", "finish"],
    },
  };
}

function primary429(): Scenario {
  return {
    name: "primary-429-retryable-no-switch",
    description: "Primary throws 429 (RetryableError); Pi retries — NO failover.",
    primary: () => { throw new RetryableError("rate limit"); },
    fallbacks: [() => streamFrom([{ type: "text", text: "should not reach" }])],
    expect: {
      switched: false,
      from: "primary/primary",
      to: "primary/primary",
      chunkTypes: [],
      error: "RetryableError",
    },
  };
}

function primaryEmitsThenDies(): Scenario {
  return {
    name: "primary-emits-one-token-then-dies",
    description: "Primary emits one text delta, then throws; NO switch (pre-first-token only).",
    primary: () => streamFrom([{ type: "text", text: "hello" }], 100)
      .then(async () => { throw new TerminalError("died after token"); }),
    fallbacks: [() => streamFrom([{ type: "text", text: "should not reach" }])],
    expect: {
      switched: false,
      from: "primary/primary",
      to: "primary/primary",
      chunkTypes: ["text"],
      error: "TerminalError",
    },
  };
}

function allCandidatesFail(): Scenario {
  return {
    name: "all-candidates-fail",
    description: "Primary times out; fallback also throws terminal error.",
    primary: () => streamFrom([], 50_000),
    fallbacks: [() => { throw new TerminalError("fallback also dead"); }],
    expect: {
      switched: false,
      from: "primary/primary",
      to: "none",
      chunkTypes: [],
      error: "TerminalError",
    },
  };
}

const SCENARIOS: Scenario[] = [
  primaryTimeout(),
  primary500(),
  primary429(),
  primaryEmitsThenDies(),
  allCandidatesFail(),
];

// ============================================================================
// Export for the test runner
// ============================================================================

export {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  SECONDARY_FALLBACK,
  SCENARIOS,
  hermesReference,
  RetryableError,
  TerminalError,
  TimeoutError,
  streamFrom,
  type Scenario,
  type HermesResult,
};