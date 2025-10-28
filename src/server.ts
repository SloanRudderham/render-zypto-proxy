import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

["ZYPTO_BASE","ZYPTO_API_KEY","ADMIN_KEY","SUPABASE_URL","SUPABASE_SERVICE_ROLE"].forEach((k)=>{
  if (!process.env[k]) throw new Error(`Missing env: ${k}`);
});

const f = Fastify({ logger: true });

// CORS + preflight
await f.register(cors, {
  origin: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-key"],
  credentials: true
});

f.get("/healthz", async () => ({ ok: true }));

const BASE = process.env.ZYPTO_BASE!;
const KEY  = process.env.ZYPTO_API_KEY!;
const ADMIN = process.env.ADMIN_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const DENY = new Set((process.env.BLOCKED_US_STATES || "")
  .split(",").map(s=>s.trim().toUpperCase()).filter(Boolean));

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// auth: allow GET/OPTIONS; also allow this POST public
f.addHook("onRequest", async (req, rep) => {
  const m = req.method;
  const p = (req.url || "").split("?")[0];
  const pre = m === "OPTIONS";
  const publicPost = m === "POST" && p === "/api/zypto/virtual-cards/check-user-email";
  if (m !== "GET" && !pre && !publicPost && req.headers["x-admin-key"] !== ADMIN) {
    return rep.code(401).send({ error: "unauthorized" });
  }
});

function safeJson(s: string) { try { return JSON.parse(s); } catch { return { raw: s }; } }

async function proxy(method: "GET" | "POST", path: string, body?: any) {
  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers: Record<string,string> = {
    Accept: "application/json",
    Authorization: `Bearer ${KEY}`
  };
  if (process.env.ZYPTO_PROJECT_ID)  headers["X-Project-Id"]  = process.env.ZYPTO_PROJECT_ID!;
  if (process.env.ZYPTO_PROGRAM_ID)  headers["X-Program-Id"]  = process.env.ZYPTO_PROGRAM_ID!;
  if (process.env.ZYPTO_BUSINESS_ID) headers["X-Business-Id"] = process.env.ZYPTO_BUSINESS_ID!;

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = randomUUID();
    return fetch(url, { method, headers, body: JSON.stringify(body || {}) });
  }
  return fetch(url, { method, headers });
}

// ---------- Routes ----------

// Upstream expects GET, so translate client POST -> Zypto GET
f.post("/api/zypto/virtual-cards/check-user-email", async (req, rep) => {
  const body = (await req.body) as any;
  const email = String(body?.email || "").trim();
  if (!email) return rep.code(400).send({ success:false, message:"email required" });

  const r = await proxy("GET", `/virtual-cards/check-user-email?email=${encodeURIComponent(email)}`);
  const text = await r.text();
  return rep.code(r.status).type("application/json").send(safeJson(text));
});

// Optional: also expose GET passthrough for direct calls
f.get("/api/zypto/virtual-cards/check-user-email", async (req: any, rep) => {
  const email = String(req.query?.email || "").trim();
  if (!email) return rep.code(400).send({ success:false, message:"email required" });
  const r = await proxy("GET", `/virtual-cards/check-user-email?email=${encodeURIComponent(email)}`);
  const text = await r.text();
  return rep.code(r.status).type("application/json").send(safeJson(text));
});

// Generic endpoints (leave as-is)
type EP = { method: "GET" | "POST"; path: string };
const endpoints: EP[] = [
  { method: "POST", path: "/virtual-cards/create-card-holder" },
  { method: "POST", path: "/virtual-cards/check-card-holder-status" },
  // { method: "POST", path: "/virtual-cards/check-user-email" }, // handled above
  { method: "POST", path: "/virtual-cards/create-card-order-deposit" },
  { method: "POST", path: "/virtual-cards/create-card-order-deposit-physical" },
  { method: "POST", path: "/virtual-cards/issue-card" },
  { method: "POST", path: "/virtual-cards/update-zip" },
  { method: "POST", path: "/virtual-cards/issue-card-physical" },
  { method: "POST", path: "/virtual-cards/load-card" },
  { method: "POST", path: "/virtual-cards/unload-card" },
  { method: "POST", path: "/virtual-cards/check-fee" },
  { method: "POST", path: "/virtual-cards/activate-card" },
  { method: "POST", path: "/virtual-cards/check-card" },
  { method: "POST", path: "/virtual-cards/check-card-status" },
  { method: "POST", path: "/virtual-cards/get-sumsub-link" },
  { method: "POST", path: "/virtual-cards/load-deposit" },
  { method: "POST", path: "/virtual-cards/get-balance" },
  { method: "POST", path: "/virtual-cards/get-transactions" },
  { method: "POST", path: "/virtual-cards/get-duplicates" },
  { method: "POST", path: "/virtual-cards/block-card" },
  { method: "POST", path: "/virtual-cards/set-pin" },
  { method: "POST", path: "/virtual-cards/get-pin" },
  { method: "POST", path: "/virtual-cards/import-cardholder" },
  { method: "POST", path: "/virtual-cards/send-code" },
  { method: "POST", path: "/virtual-cards/delete-cardholder" },
  { method: "POST", path: "/virtual-cards/send-code-delete-cardholder" },
  { method: "POST", path: "/virtual-cards/move-cardholder" },
  { method: "POST", path: "/virtual-cards/set-agreements" },
  { method: "GET",  path: "/virtual-cards/get-allowance-balance" },
  { method: "POST", path: "/virtual-cards/send-declined-email" }
];

for (const ep of endpoints) {
  const local = `/api/zypto${ep.path}`;
  if (ep.method === "POST") {
    f.post(local, async (req, rep) => {
      const body = (await req.body) as any;

      if (ep.path === "/virtual-cards/create-card-holder") {
        const country = String(body?.country || body?.Country || "").toUpperCase();
        const state   = String(body?.state   || body?.State   || "").toUpperCase();
        if (country === "US" && state && DENY.has(state)) {
          return rep.code(400).send({ success:false, message:`Card unavailable in ${state}` });
        }
        if (body?.sharedToken && !body?.ipAddress) {
          return rep.code(400).send({ success:false, message:"ipAddress required when sharedToken is used" });
        }
      }

      const r = await proxy("POST", ep.path, body);
      const text = await r.text();
      return rep.code(r.status).type("application/json").send(safeJson(text));
    });
  } else {
    f.get(local, async (req: any, rep) => {
      const r = await proxy("GET", ep.path);
      const text = await r.text();
      return rep.code(r.status).type("application/json").send(safeJson(text));
    });
  }
}

// stats
f.post("/api/zypto/cards/statistic", async (req, rep) => {
  const r = await proxy("POST", "/cards/statistic", (await req.body) || {});
  const text = await r.text();
  return rep.code(r.status).type("application/json").send(safeJson(text));
});

const port = Number(process.env.PORT) || 3000;
f.listen({ port, host: "0.0.0.0" });
