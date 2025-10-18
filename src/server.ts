import "dotenv/config";
import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const f = Fastify({ logger: true });

// e.g. https://dash.zypto.com/api
const BASE = process.env.ZYPTO_BASE!;
const KEY  = process.env.ZYPTO_API_KEY!;
const ADMIN = process.env.ADMIN_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

const DENY = new Set(
  (process.env.BLOCKED_US_STATES || "")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
);

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// auth gate
f.addHook("onRequest", async (req, rep) => {
  if (req.method !== "GET") {
    if (req.headers["x-admin-key"] !== ADMIN) {
      return rep.code(401).send({ error: "unauthorized" });
    }
  }
});

type EP = { method: "GET" | "POST"; path: string };

const endpoints: EP[] = [
  { method: "POST", path: "/virtual-cards/create-card-holder" },
  { method: "POST", path: "/virtual-cards/check-card-holder-status" },
  { method: "POST", path: "/virtual-cards/check-user-email" },
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

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

async function proxy(method: "GET" | "POST", path: string, body?: any) {
  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers: any = {
    Accept: "application/json",
    Authorization: `Bearer ${KEY}`
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = randomUUID();
    return fetch(url, { method, headers, body: JSON.stringify(body || {}) });
  }
  return fetch(url, { method, headers });
}

function countryOf(b: any) { return String(b?.country || b?.Country || "").toUpperCase(); }
function stateOf(b: any) { return String(b?.state || b?.State || "").toUpperCase(); }

for (const ep of endpoints) {
  const local = `/api/zypto${ep.path}`;

  if (ep.method === "POST") {
    f.post(local, async (req, rep) => {
      const body = (await req.body) as any;

      if (ep.path === "/virtual-cards/create-card-holder") {
        if (countryOf(body) === "US" && stateOf(body) && DENY.has(stateOf(body))) {
          return rep.code(400).send({ success: false, message: `Card unavailable in ${stateOf(body)}` });
        }
        if (body?.sharedToken && !body?.ipAddress) {
          return rep.code(400).send({ success: false, message: "ipAddress required when sharedToken is used" });
        }
      }

      const r = await proxy("POST", ep.path, body);
      const text = await r.text();
      return rep.code(r.status).type("application/json").send(safeJson(text));
    });
  } else {
    f.get(local, async (_req, rep) => {
      const r = await proxy("GET", ep.path);
      const text = await r.text();
      return rep.code(r.status).type("application/json").send(safeJson(text));
    });
  }
}

const port = Number(process.env.PORT) || 3000;
f.listen({ port, host: "0.0.0.0" });
