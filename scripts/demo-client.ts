/**
 * A minimal MCP *client* that exercises the EvenKeel MCP server end-to-end.
 *
 * It does exactly what a host like Claude Desktop does: launch the server as a
 * stdio subprocess, perform the MCP handshake, then list and invoke every
 * primitive — tools, resources (static + templated), and prompts. Running this
 * is the integration test: if it prints results, the protocol round-trips.
 *
 *   npm run demo
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "src", "server.ts");

function hr(title: string) {
  console.log("\n" + "─".repeat(72) + `\n▶ ${title}\n` + "─".repeat(72));
}
function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

async function main() {
  // Launch the TS server via Node's tsx loader — same path the spike validated.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverPath],
    stderr: "inherit",
  });

  const client = new Client({ name: "evenkeel-demo-client", version: "0.1.0" });
  await client.connect(transport);
  console.log("✓ Connected to evenkeel-mcp over stdio.");

  /* ------------------------------- tools -------------------------------- */
  hr("TOOLS — discovery");
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`  • ${t.name} — ${t.title ?? ""}`);

  hr("TOOL CALL — get_monthly_spending { lastN: 6 }");
  const spend = await client.callTool({ name: "get_monthly_spending", arguments: { lastN: 6 } });
  console.log(textOf(spend));

  hr("TOOL CALL — audit_subscriptions {}  (note the validated structuredContent)");
  const subs = await client.callTool({ name: "audit_subscriptions", arguments: {} });
  console.log(textOf(subs));
  const sc = (subs as { structuredContent?: { totalAnnual?: number } }).structuredContent;
  console.log(`\n  structuredContent.totalAnnual = ${sc?.totalAnnual}  (machine-readable, schema-validated)`);

  hr("TOOL CALL — find_savings { lastN: 8 }");
  const savings = await client.callTool({ name: "find_savings", arguments: { lastN: 8 } });
  console.log(textOf(savings));

  hr("TOOL CALL — get_insights { lastN: 8 }");
  const insights = await client.callTool({ name: "get_insights", arguments: { lastN: 8 } });
  console.log(textOf(insights));

  /* ----------------------------- resources ------------------------------ */
  hr("RESOURCES — discovery");
  const { resources } = await client.listResources();
  for (const r of resources) console.log(`  • ${r.uri} — ${r.name ?? r.title ?? ""}`);
  const { resourceTemplates } = await client.listResourceTemplates();
  for (const t of resourceTemplates) console.log(`  • (template) ${t.uriTemplate} — ${t.name ?? t.title ?? ""}`);

  hr("RESOURCE READ — evenkeel://dataset/summary");
  const summary = await client.readResource({ uri: "evenkeel://dataset/summary" });
  console.log(summary.contents.map((c) => ("text" in c ? c.text : "")).join("\n"));

  const monthRes = resources.find((r) => r.uri.startsWith("evenkeel://expenses/"));
  if (monthRes) {
    hr(`RESOURCE READ (templated) — ${monthRes.uri}`);
    const month = await client.readResource({ uri: monthRes.uri });
    const body = month.contents[0];
    const json = body && "text" in body ? (body.text as string) : "{}";
    const parsed = JSON.parse(json) as { month: string; count: number; items: unknown[] };
    console.log(`  ${parsed.month}: ${parsed.count} line items (first 3 shown in JSON):`);
    console.log("  " + JSON.stringify(parsed.items.slice(0, 3), null, 2).replace(/\n/g, "\n  "));
  }

  /* ------------------------------ prompts ------------------------------- */
  hr("PROMPTS — discovery");
  const { prompts } = await client.listPrompts();
  for (const p of prompts) console.log(`  • ${p.name} — ${p.title ?? ""}`);

  hr("PROMPT GET — review_my_finances { lastN: '6' }");
  const prompt = await client.getPrompt({ name: "review_my_finances", arguments: { lastN: "6" } });
  console.log(prompt.messages.map((m) => `  [${m.role}] ${m.content.type === "text" ? m.content.text : ""}`).join("\n"));

  await client.close();
  console.log("\n✓ Done. Closed the connection cleanly.");
}

main().catch((err) => {
  console.error("demo-client failed:", err);
  process.exit(1);
});
