/**
 * POST /api/webhook
 *
 * Recebe eventos do Stripe via webhook.
 * Verifique a assinatura para garantir que o evento veio do Stripe.
 *
 * Configuração no Stripe Dashboard:
 *   → Developers → Webhooks → Add endpoint
 *   → URL: https://herework.com.br/api/webhook
 *   → Eventos: payment_intent.succeeded
 *               payment_intent.payment_failed
 *               payment_intent.canceled
 *               charge.dispute.created
 *
 * Variável de ambiente necessária:
 *   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
 *   (obtida no Stripe Dashboard ao criar o webhook)
 */

const { getStripe, respond } = require('./_helpers');

/* Desabilita o parsing do body do Next.js / Vercel para webhooks
   (precisamos do raw body para verificar a assinatura do Stripe) */
module.exports.config = {
  api: { bodyParser: false }
};

/* ── Supabase Admin helper (usa service role key — server-side only) ── */
async function sbAdmin(method, path, body) {
  const url  = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + path;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[HereWork] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.');
    return null;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[HereWork] Supabase error', res.status, text);
  }
  return res;
}

async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, req);

  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig)    return respond(res, 400, { error: 'Stripe-Signature ausente.' }, req);
  if (!secret) return respond(res, 500, { error: 'STRIPE_WEBHOOK_SECRET não configurado.' }, req);

  let event;

  try {
    const stripe  = getStripe();
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[HereWork] Webhook signature error:', err.message);
    return respond(res, 400, { error: 'Assinatura inválida: ' + err.message }, req);
  }

  /* ── Processa os eventos ── */
  console.log('[HereWork] Webhook recebido:', event.type, event.id);

  switch (event.type) {

    case 'payment_intent.succeeded': {
      const pi         = event.data.object;
      const contractId = pi.metadata && pi.metadata.contract_id;
      const planId     = pi.metadata && pi.metadata.plan_id;
      const userId     = pi.metadata && pi.metadata.user_id;
      console.log(`[HereWork] ✅ Pagamento confirmado: ${pi.id} — R$ ${pi.amount / 100}` +
                  (contractId ? ` — contrato ${contractId}` : ''));

      /* 1. Marcar contrato como ativo + escrow liberado */
      if (contractId) {
        await sbAdmin('PATCH',
          `/rest/v1/contracts?id=eq.${contractId}`,
          {
            escrow_released: true,
            paid_at:         new Date().toISOString(),
            started_at:      new Date().toISOString(),
            status:          'active'
          }
        );
        console.log(`[HereWork] Contrato ${contractId} atualizado: escrow liberado.`);
      }

      /* 2. Upgrade de plano (quando payment intent veio da tela de planos) */
      if (planId && userId) {
        const allowedPlans = ['free', 'pro', 'enterprise'];
        if (allowedPlans.includes(planId)) {
          await sbAdmin('PATCH',
            `/rest/v1/profiles?id=eq.${userId}`,
            { plan: planId }
          );
          console.log(`[HereWork] Usuário ${userId} atualizado para plano ${planId}.`);
        }
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi  = event.data.object;
      const err = pi.last_payment_error;
      const cid = pi.metadata && pi.metadata.contract_id;
      console.warn(`[HereWork] ❌ Pagamento falhou: ${pi.id} — ${err && err.message}`);

      /* Marcar contrato como disputado se estava aguardando pagamento */
      if (cid) {
        await sbAdmin('PATCH',
          `/rest/v1/contracts?id=eq.${cid}&status=eq.active`,
          { status: 'disputed' }
        );
      }
      break;
    }

    case 'payment_intent.canceled': {
      const pi  = event.data.object;
      const cid = pi.metadata && pi.metadata.contract_id;
      console.warn(`[HereWork] ⚠️ Pagamento cancelado: ${pi.id}`);
      if (cid) {
        await sbAdmin('PATCH',
          `/rest/v1/contracts?id=eq.${cid}`,
          { status: 'cancelled' }
        );
      }
      break;
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object;
      console.error(`[HereWork] 🚨 Chargeback aberto: ${dispute.id} — R$ ${dispute.amount / 100}`);
      /* Alerta urgente — marcar contrato como 'disputed' se vinculado */
      const piId = dispute.payment_intent;
      if (piId) {
        /* Tenta encontrar e marcar o contrato via metadata stripe_pi_id */
        /* Requer coluna stripe_pi_id em contracts — omitido por ora; monitore via Stripe Dashboard */
        console.error(`[HereWork] 🚨 PaymentIntent vinculado: ${piId} — ação manual necessária.`);
      }
      break;
    }

    default:
      console.log(`[HereWork] Evento ignorado: ${event.type}`);
  }

  /* Sempre retornar 200 para o Stripe saber que recebemos */
  return respond(res, 200, { received: true, type: event.type }, req);
};
