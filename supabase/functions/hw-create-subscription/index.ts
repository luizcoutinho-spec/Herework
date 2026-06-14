import Stripe from "npm:stripe@14";

const ALLOWED_ORIGINS = [
  "https://www.herework.com.br",
  "https://herework.com.br",
  "https://herework.vercel.app",
];
const _envOrigin = Deno.env.get("ALLOWED_ORIGIN");
if (_envOrigin && !ALLOWED_ORIGINS.includes(_envOrigin)) ALLOWED_ORIGINS.push(_envOrigin);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_TEST  = (Deno.env.get("STRIPE_SECRET_KEY_TEST") || "").trim();

const stripe = new Stripe(STRIPE_TEST, { apiVersion: "2024-06-20" });

const PLAN_MAP: Record<string, { month: string; year: string; plan: string }> = {
  business: { month: "price_1TiFWgHXgU6QiY3Xc6NPW2rP", year: "price_1TiIUoHXgU6QiY3X9mInCbKV", plan: "pro" },
  premium:  { month: "price_1TiFZYHXgU6QiY3X4Pw207xn", year: "price_1TiIVKHXgU6QiY3XgoOPmxS8", plan: "pro" },
  elite:    { month: "price_1TiFaqHXgU6QiY3XispsUjbX", year: "price_1TiIVkHXgU6QiY3XqbCzApym", plan: "enterprise" },
};

const ACTIVE_SUB_STATUSES = ["active", "trialing", "past_due", "incomplete"];

async function getUid(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

async function sbSelect(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function sbPatch(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req) => {
  const CORS = corsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, CORS);

  const uid = await getUid(req.headers.get("authorization"));
  if (!uid) return json({ error: "Não autenticado." }, 401, CORS);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400, CORS); }
  const planKey = String(body?.plan || "").toLowerCase();
  const interval = (String(body?.interval || "month").toLowerCase() === "year") ? "year" : "month";
  const mapped = PLAN_MAP[planKey];
  if (!mapped) return json({ error: "Plano inválido." }, 400, CORS);
  const priceId = interval === "year" ? mapped.year : mapped.month;

  const profile = await sbSelect(
    `profiles?id=eq.${uid}&select=id,email,stripe_customer_id,stripe_subscription_id`
  );
  if (!profile) return json({ error: "Perfil não encontrado." }, 404, CORS);

  try {
    if (profile.stripe_subscription_id) {
      try {
        const existing = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
        if (existing && ACTIVE_SUB_STATUSES.includes(existing.status)) {
          return json({ error: "Você já possui uma assinatura ativa.", code: "already_subscribed" }, 409, CORS);
        }
      } catch (_e) {
        // subscription gravada não existe mais no Stripe — segue para criar nova
      }
    }

    let customerId = profile.stripe_customer_id || null;
    if (customerId) {
      try {
        const c = await stripe.customers.retrieve(customerId);
        if ((c as any)?.deleted) customerId = null;
      } catch (_e) { customerId = null; }
    }
    if (!customerId) {
      const search = await stripe.customers.search({
        query: `metadata['user_id']:'${uid}'`,
        limit: 1,
      }).catch(() => null);
      if (search && search.data && search.data.length > 0) {
        customerId = search.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: profile.email || undefined,
          metadata: { user_id: uid },
        });
        customerId = customer.id;
      }
      await sbPatch(`profiles?id=eq.${uid}`, { stripe_customer_id: customerId });
    }

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: { user_id: uid, plan: mapped.plan },
    });

    let clientSecret: string | null = null;
    const invoice: any = sub.latest_invoice;
    if (invoice && typeof invoice === "object" && invoice.payment_intent) {
      const piObj: any = invoice.payment_intent;
      clientSecret = typeof piObj === "object" ? piObj.client_secret : null;
      if (!clientSecret && typeof piObj === "string") {
        const pi = await stripe.paymentIntents.retrieve(piObj).catch(() => null);
        clientSecret = pi?.client_secret || null;
      }
    } else if (invoice && typeof invoice === "string") {
      const inv: any = await stripe.invoices.retrieve(invoice, { expand: ["payment_intent"] }).catch(() => null);
      const piObj: any = inv?.payment_intent;
      clientSecret = piObj && typeof piObj === "object" ? piObj.client_secret : null;
    }

    if (!clientSecret) {
      try { await stripe.subscriptions.cancel(sub.id); } catch (_e) { /* best effort */ }
      return json({ error: "Não foi possível iniciar o pagamento da assinatura." }, 502, CORS);
    }

    return json({
      clientSecret,
      subscriptionId: sub.id,
      customerId,
    }, 200, CORS);

  } catch (err) {
    console.error("[hw-create-subscription] erro:", (err as any)?.message || err);
    return json({ error: "Erro ao processar assinatura. Tente novamente." }, 500, CORS);
  }
});
