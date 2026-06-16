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

function isValidTaxId(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14;
}

Deno.serve(async (req) => {
  const CORS = corsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405, CORS);

  // 1. Auth
  const uid = await getUid(req.headers.get("authorization"));
  if (!uid) return json({ error: "Não autenticado." }, 401, CORS);

  // 2. Body
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400, CORS); }

  const { paymentIntentId, name, email, taxId, line1, postalCode, city, state } = body ?? {};

  // 3. Validação de campos obrigatórios
  if (!paymentIntentId) return json({ error: "paymentIntentId obrigatório." }, 400, CORS);
  if (!name)            return json({ error: "Nome completo obrigatório para emissão do boleto." }, 400, CORS);
  if (!email)           return json({ error: "E-mail obrigatório para emissão do boleto." }, 400, CORS);
  if (!taxId)           return json({ error: "CPF ou CNPJ obrigatório para emissão do boleto." }, 400, CORS);
  if (!line1)           return json({ error: "Endereço (rua e número) obrigatório para emissão do boleto." }, 400, CORS);
  if (!postalCode)      return json({ error: "CEP obrigatório para emissão do boleto." }, 400, CORS);
  if (!city)            return json({ error: "Cidade obrigatória para emissão do boleto." }, 400, CORS);
  if (!state)           return json({ error: "Estado obrigatório para emissão do boleto." }, 400, CORS);

  // 4. Validação CPF/CNPJ (formato — dígitos verificadores não validados aqui)
  if (!isValidTaxId(taxId)) {
    return json({ error: "CPF deve ter 11 dígitos e CNPJ deve ter 14 dígitos." }, 422, CORS);
  }

  const taxIdDigits = taxId.replace(/\D/g, "");

  // 5. Retrieve PI — verificar dono e estado antes de confirmar
  let piCheck: Stripe.PaymentIntent;
  try {
    piCheck = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err: any) {
    return json({ error: "Pagamento não encontrado." }, 404, CORS);
  }

  if (piCheck.metadata?.client_id !== uid) {
    return json({ error: "Você não tem permissão para este pagamento." }, 403, CORS);
  }

  const CONFIRMABLE = ["requires_payment_method", "requires_confirmation"];
  if (!CONFIRMABLE.includes(piCheck.status)) {
    const msg: Record<string, string> = {
      succeeded:  "Este pagamento já foi concluído com sucesso.",
      processing: "Este pagamento já está em processamento.",
      canceled:   "Este pagamento foi cancelado. Inicie um novo pagamento.",
    };
    return json({ error: msg[piCheck.status] ?? "Pagamento em estado inválido para emissão de boleto (" + piCheck.status + ")." }, 409, CORS);
  }

  // 6. Confirmar PaymentIntent com Stripe
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method_data: {
        type: "boleto",
        boleto: { tax_id: taxIdDigits },
        billing_details: {
          name,
          email,
          address: {
            line1,
            city,
            state,
            postal_code: postalCode.replace(/\D/g, "").replace(/^(\d{5})(\d{3})$/, "$1-$2"),
            country: "BR",
          },
        },
      },
    } as any);
  } catch (err: any) {
    const code    = err?.code || "";
    const message = err?.message || "";

    if (/invalid_tax_id|tax_id/i.test(code) || /cpf|cnpj|tax.id/i.test(message)) {
      return json({ error: "CPF ou CNPJ inválido. Verifique o número informado." }, 422, CORS);
    }
    if (/invalid_request|parameter_invalid/i.test(code) && /address/i.test(message)) {
      return json({ error: "Endereço inválido. Verifique os dados informados." }, 422, CORS);
    }
    if (/payment_intent_unexpected_state/i.test(code)) {
      return json({ error: "Este pagamento já foi processado ou cancelado. Inicie um novo pagamento." }, 409, CORS);
    }
    if (/payment_intent_incompatible_payment_method/i.test(code)) {
      return json({ error: "O boleto não é compatível com este pagamento. Escolha outra forma de pagamento." }, 422, CORS);
    }

    console.error("[confirm-boleto] Stripe error:", { code, message, piId: paymentIntentId });
    return json({ error: "Não foi possível gerar o boleto. Tente novamente." }, 502, CORS);
  }

  // 6. Extrair boleto_display_details
  const details = (pi.next_action as any)?.boleto_display_details;
  if (!details) {
    console.error("[confirm-boleto] next_action.boleto_display_details ausente. status:", pi.status, "piId:", paymentIntentId);
    return json({ error: "Boleto gerado mas dados de exibição não disponíveis. Contate o suporte." }, 500, CORS);
  }

  // doc: .hosted_voucher_url, .number, .pdf, .expires_at
  return json({
    boletoUrl:    details.hosted_voucher_url ?? null,
    boletoNumber: details.number            ?? null,
    boletoPdf:    details.pdf               ?? null,
    expiresAt:    details.expires_at        ?? null,
  }, 200, CORS);
});
