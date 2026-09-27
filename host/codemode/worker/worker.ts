import { DynamicWorkerExecutor, generateTypesFromJsonSchema } from "@cloudflare/codemode";
import type { JsonSchemaToolDescriptor } from "@cloudflare/codemode";

interface Env {
  LOADER: WorkerLoader;
}

type ToolFn = (...args: unknown[]) => Promise<unknown>;

interface GenerateBody {
  tools: Array<{ name: string; description?: string; inputSchema?: JsonSchemaToolDescriptor["inputSchema"] }>;
  namespace?: string;
}

interface ExecuteBody {
  code: string;
  toolNames: string[];
  callbackUrl: string;
  namespace?: string;
  timeoutMs?: number;
}

async function handleGenerate(body: GenerateBody): Promise<Response> {
  const { tools, namespace = "codemode" } = body;
  const map: Record<string, JsonSchemaToolDescriptor> = {};
  for (const t of tools) {
    map[t.name] = {
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema ?? { type: "object" },
    };
  }
  let block = generateTypesFromJsonSchema(map);
  if (namespace !== "codemode") {
    block = block.replace(/declare const codemode:/, `declare const ${namespace}:`);
  }
  return new Response(JSON.stringify({ apiBlock: block }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleExecute(body: ExecuteBody, env: Env): Promise<Response> {
  const { code, toolNames, callbackUrl, namespace = "chrome", timeoutMs } = body;
  const budgetMs = timeoutMs ?? 180_000;

  // Record one entry per inner tool call (in invocation order, with the
  // wall-clock latency of the proxy roundtrip). This is purely at our
  // orchestration layer — codemode's executor sees the same fns it
  // would otherwise, just lightly wrapped.
  const calls: Array<{ tool: string; latencyMs: number }> = [];

  const fns: Record<string, ToolFn> = {};
  for (const name of toolNames) {
    fns[name] = async (args) => {
      const start = Date.now();
      try {
        const res = await fetch(`${callbackUrl}/tool/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args ?? {}),
        });
        const respBody: unknown = await res.json();
        if (!res.ok) {
          const error = (respBody as { error?: unknown } | null)?.error;
          throw new Error(typeof error === "string" ? error : `tool ${name} failed: ${res.status}`);
        }
        return respBody;
      } finally {
        calls.push({ tool: name, latencyMs: Date.now() - start });
      }
    };
  }

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: budgetMs,
    globalOutbound: null,
  });

  const t0 = Date.now();
  const result = await executor.execute(code, [{ name: namespace, fns }]);
  const latencyMs = Date.now() - t0;

  return new Response(JSON.stringify({ ...result, latencyMs, calls }), {
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    // Both callers are this repo's own servers (host/codemode/common.ts), which
    // send exactly these shapes.
    const body: unknown = await request.json();
    if (url.pathname === "/generate") return handleGenerate(body as GenerateBody);
    if (url.pathname === "/execute") return handleExecute(body as ExecuteBody, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
