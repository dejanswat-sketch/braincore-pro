import fs from "node:fs";
const ROOT = "E:\\NMQ-PROGRAMI\\nmq-robot";
process.chdir(ROOT);
const txt = fs.readFileSync(ROOT + "\\.env", "utf8");
for (const line of txt.split(/\r?\n/)) { const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { loadConfig } = await import("./src/core/config.js");
const cfg = loadConfig ? loadConfig() : null;
console.log("  llm config: " + JSON.stringify(cfg?.llm || cfg));
const { createOpenAiCompatibleProvider } = await import("./src/llm/openai-compatible.js");
const p = createOpenAiCompatibleProvider({
  baseUrl: process.env.NMQ_LLM_BASE_URL,
  apiKey: process.env.NMQ_LLM_API_KEY,
  model: process.env.NMQ_LLM_MODEL,
  timeoutMs: Number(process.env.NMQ_LLM_TIMEOUT_MS)
});
const t0 = Date.now();
const out = await p.chat({ messages: [{ role: "user", content: "Reply with exactly: ROBOT LOKALNO" }] });
console.log("  odgovor (" + ((Date.now()-t0)/1000).toFixed(1) + "s): " + JSON.stringify(out).slice(0, 200));
process.exit(0);
