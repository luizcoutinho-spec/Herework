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
      const md         = pi.metadata || {};
      const proposalId = md.proposal_id;
      const planId     = md.plan_id;
      const userId     = md.user_id;

      const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
      const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const sbHeaders = {
        'apikey':        SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
        'Content-Type':  'application/json'
      };

      console.log(`[HereWork] ✅ Pagamento confirmado: ${pi.id} — R$ ${pi.amount / 100}` +
                  (proposalId ? ` — proposta ${proposalId}` : ''));

      /* ── A) CONTRATAÇÃO: pagamento de uma proposta cria o contrato (escrow retido) ── */
      if (proposalId) {
        try {
          /* A.1 IDEMPOTÊNCIA: já existe contrato com este payment_intent? Não recria. */
          const existingRes = await fetch(
            `${SUPABASE_URL}/rest/v1/contracts?stripe_payment_intent_id=eq.${encodeURIComponent(pi.id)}&select=id&limit=1`,
            { headers: sbHeaders }
          );
          const existing = existingRes.ok ? await existingRes.json() : [];
          if (Array.isArray(existing) && existing.length > 0) {
            console.log(`[HereWork] Contrato já existe para ${pi.id} (${existing[0].id}) — idempotente, ignorando.`);
            break;
          }

          /* A.2 Ler a proposta (fonte da verdade do value e deadline) */
          const propRes = await fetch(
            `${SUPABASE_URL}/rest/v1/proposals?id=eq.${encodeURIComponent(proposalId)}&select=id,project_id,freelancer_id,value,deadline_days&limit=1`,
            { headers: sbHeaders }
          );
          const propRows = propRes.ok ? await propRes.json() : [];
          if (!Array.isArray(propRows) || propRows.length === 0) {
            console.error(`[HereWork] CRÍTICO: proposta ${proposalId} não encontrada para pi ${pi.id}. Pagamento sem contrato — reconciliar manualmente.`);
            break;
          }
          const prop = propRows[0];

          /* A.3 Título do contrato vem do projeto (fallback se faltar) */
          let title = 'Contrato ' + prop.id;
          try {
            const projRes = await fetch(
              `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(prop.project_id)}&select=title&limit=1`,
              { headers: sbHeaders }
            );
            const projRows = projRes.ok ? await projRes.json() : [];
            if (Array.isArray(projRows) && projRows.length > 0 && projRows[0].title) {
              title = projRows[0].title;
            }
          } catch (e) { console.warn('[HereWork] título do projeto indisponível:', e.message); }

          /* A.4 CRÍTICO: criar o contrato — escrow RETIDO (escrow_released=false) */
          const clientId     = md.client_id     || null;
          const freelancerId = md.freelancer_id || prop.freelancer_id;
          const nowIso = new Date().toISOString();
          const insertRes = await fetch(
            `${SUPABASE_URL}/rest/v1/contracts`,
            {
              method:  'POST',
              headers: { ...sbHeaders, 'Prefer': 'return=representation' },
              body: JSON.stringify({
                project_id:               prop.project_id,
                proposal_id:              prop.id,
                client_id:                clientId,
                freelancer_id:            freelancerId,
                title:                    title,
                value:                    prop.value,
                deadline_days:            prop.deadline_days,
                status:                   'active',
                escrow_released:          false,
                stripe_payment_intent_id: pi.id,
                paid_at:                  nowIso,
                started_at:               nowIso
              })
            }
          );
          if (!insertRes.ok) {
            const t = await insertRes.text().catch(() => '');
            console.error(`[HereWork] CRÍTICO: falha ao criar contrato para pi ${pi.id} — pagamento recebido SEM contrato. Reconciliar. erro:`, insertRes.status, t);
            break;
          }
          const created = await insertRes.json();
          const newContractId = Array.isArray(created) && created[0] ? created[0].id : '(id?)';
          console.log(`[HereWork] Contrato ${newContractId} criado (escrow retido) para pi ${pi.id}.`);

          /* A.5 SECUNDÁRIO (best-effort, não bloqueia o dinheiro): proposta + projeto */
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/proposals?id=eq.${encodeURIComponent(prop.id)}`,
              { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
                body: JSON.stringify({ status: 'accepted' }) });
          } catch (e) { console.warn('[HereWork] PATCH proposta falhou (cosmético):', e.message); }
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(prop.project_id)}`,
              { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
                body: JSON.stringify({ status: 'in_progress' }) });
          } catch (e) { console.warn('[HereWork] PATCH projeto falhou (cosmético):', e.message); }

        } catch (err) {
          console.error(`[HereWork] CRÍTICO: erro inesperado ao processar contratação do pi ${pi.id}:`, err.message);
        }
      }

      /* ── B) UPGRADE DE PLANO (preservado: payment intent da tela de planos) ── */
      if (planId && userId) {
        const allowedPlans = ['free', 'pro', 'enterprise'];
        if (allowedPlans.includes(planId)) {
          await sbAdmin('PATCH', `/rest/v1/profiles?id=eq.${userId}`, { plan: planId });
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

      /* Marcar contrato como disputado independentemente do status atual.
         O filtro &status=eq.active foi removido: ele silenciava o update
         quando o contrato não estava exatamente em 'active' (ex: 'pending',
         'review'), impedindo o registro do status 'disputed'. */
      if (cid) {
        await sbAdmin('PATCH',
          `/rest/v1/contracts?id=eq.${encodeURIComponent(cid)}`,
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
          `/rest/v1/contracts?id=eq.${encodeURIComponent(cid)}`,
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
