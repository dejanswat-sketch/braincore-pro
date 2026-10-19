import fs from "node:fs";
const ROOT = "E:\\NMQ-PROGRAMI\\nmq-robot";
process.chdir(ROOT);
const txt = fs.readFileSync(ROOT + "\\.env", "utf8");
for (const line of txt.split(/\r?\n/)) { const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { envConfig } = await import("./src/core/config.js");
const env = envConfig();
const noop = { warn(){}, info(){}, error(){} };
const metrics = { inc(){}, observe(){}, gauge(){}, hist(){}, timing(){} };
const { createLlm } = await import("./src/llm/index.js");
const llm = createLlm({ env, logger: noop, metrics });
console.log("  lanac: " + llm.providers.map(p => p.name).join(" -> "));
// 1) normalan poziv (lokalni)
let t0 = Date.now();
const a = await llm.chat({ messages: [{ role: "user", content: "Reply exactly: LOKALNI" }], useCache: false });
console.log("  1) lokalni (" + ((Date.now()-t0)/1000).toFixed(1) + "s): " + String(a.text||"").trim().slice(0,40) + " · provider=" + a.provider);
// 2) simulacija pada lokalnog: unistimo primarni provider
llm.providers[0].chat = async () => { throw new Error("simulirani pad lokalnog modela"); };
t0 = Date.now();
const b = await llm.chat({ messages: [{ role: "user", content: "Reply exactly: REZERVA" }], useCache: false });
console.log("  2) posle pada (" + ((Date.now()-t0)/1000).toFixed(1) + "s): " + String(b.text||"").trim().slice(0,40) + " · provider=" + b.provider);
console.log("  HIBRID: " + (String(b.provider).includes("fallback") ? "RADI - prebacio na DeepSeek ✓" : "nije prebacio"));
process.exit(0);
