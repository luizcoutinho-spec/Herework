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

Deno.serve(async (req) => {
  const CORS = corsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, CORS);

  // 1. autenticação
  const uid = await getUid(req.headers.get("authorization"));
  if (!uid) return json({ error: "Não autenticado." }, 401, CORS);

  // 2. input
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400, CORS); }
  const proposalId = body?.proposalId;
  if (!proposalId) return json({ error: "proposalId obrigatório." }, 400, CORS);

  // 3. busca a proposta (valor vem do BANCO — nunca do cliente)
  const proposal = await sbSelect(
    `proposals?id=eq.${proposalId}&select=id,value,project_id,freelancer_id,status`
  );
  if (!proposal) return json({ error: "Proposta não encontrada." }, 404, CORS);
  const CONTRACTABLE = ["pending", "viewed", "shortlisted"];
  if (!CONTRACTABLE.includes(proposal.status))
    return json({ error: "Proposta não está disponível para pagamento." }, 409, CORS);

  // 4. busca o projeto (para validar o cliente)
  const project = await sbSelect(
    `projects?id=eq.${proposal.project_id}&select=id,client_id,title`
  );
  if (!project) return json({ error: "Projeto não encontrado." }, 404, CORS);

  // 5. SÓ O CLIENTE do projeto pode pagar
  if (project.client_id !== uid)
    return json({ error: "Apenas o cliente do projeto pode efetuar o pagamento." }, 403, CORS);

  // 6. cria o PaymentIntent em modo TESTE
  const amountCents = Math.round(Number(proposal.value) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0)
    return json({ error: "Valor da proposta inválido." }, 422, CORS);

  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "brl",
    automatic_payment_methods: { enabled: true },
    metadata: {
      proposal_id:   String(proposal.id),
      project_id:    String(project.id),
      client_id:     String(project.client_id),
      freelancer_id: String(proposal.freelancer_id),
    },
    description: `HereWork - ${project.title}`,
  });

  return json({ clientSecret: pi.client_secret }, 200, CORS);
});
