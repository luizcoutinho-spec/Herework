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
      // NOTA: este path (plan_id) é legado de PaymentIntent avulso. Assinaturas ativam via
      // Bloco B (customer.subscription.created, que lê metadata.plan). Não usar para subscriptions.
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

          /* A.2b REGRA 1:1 — projeto já tem contrato vivo? Não cria 2º. */
          const liveRes = await fetch(
            `${SUPABASE_URL}/rest/v1/contracts?project_id=eq.${encodeURIComponent(prop.project_id)}&status=neq.cancelled&select=id&limit=1`,
            { headers: sbHeaders }
          );
          const live = liveRes.ok ? await liveRes.json() : [];
          if (Array.isArray(live) && live.length > 0) {
            console.error(`[HereWork] REGRA 1:1: projeto ${prop.project_id} ja tem contrato vivo (${live[0].id}). Pagamento ${pi.id} NAO criou contrato — RECONCILIAR/ESTORNAR manualmente.`);
            break;
          }

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
                status:                   'pending_acceptance',
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

          /* marca a proposta aceita como accepted (some o botao Contratar nela) */
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/proposals?id=eq.${encodeURIComponent(proposalId)}`,
              { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ status: 'accepted', updated_at: new Date().toISOString() }) });
          } catch (e) { console.error(`[HereWork] falha ao marcar proposta accepted (pi ${pi.id}):`, e && (e.message||e)); }

          /* fecha o projeto — regra 1:1 (status interno 'contracted') */
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(prop.project_id)}`,
              { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ status: 'in_progress' }) });
          } catch (e) { console.error(`[HereWork] falha ao fechar projeto contracted (pi ${pi.id}):`, e && (e.message||e)); }

          /* A.5 RECUSA EM LOTE: descartar as outras propostas abertas do mesmo projeto */
          try {
            const rejectRes = await fetch(
              `${SUPABASE_URL}/rest/v1/proposals` +
              `?project_id=eq.${prop.project_id}` +
              `&id=neq.${proposalId}` +
              `&status=in.(pending,viewed,shortlisted)`,
              {
                method: 'PATCH',
                headers: { ...sbHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify({ status: 'rejected', updated_at: new Date().toISOString() })
              }
            );
            if (!rejectRes.ok) {
              const errTxt = await rejectRes.text();
              console.error(`[HereWork] recusa em lote falhou (pi ${pi.id}): ${rejectRes.status} ${errTxt}`);
            } else {
              const rejected = await rejectRes.json();
              console.log(`[HereWork] recusa em lote: ${Array.isArray(rejected) ? rejected.length : 0} proposta(s) recusada(s) no projeto ${prop.project_id}.`);
            }
          } catch (e) {
            console.error(`[HereWork] recusa em lote exceção (pi ${pi.id}):`, e && (e.message || e));
          }

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

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const userId = sub.metadata && sub.metadata.user_id;
        const plan        = sub.metadata && sub.metadata.plan;
        const planVariant = sub.metadata && sub.metadata.plan_variant;
        const allowed = ['free', 'pro', 'enterprise'];
        if (userId && allowed.includes(plan) && ['active', 'trialing'].includes(sub.status)) {
          const periodEnd = sub.current_period_end
            || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end)
            || null;
          await sbAdmin('PATCH', `/rest/v1/profiles?id=eq.${userId}`, {
            plan:                   plan,
            plan_status:            sub.status,
            stripe_subscription_id: sub.id,
            plan_expires_at:        periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            plan_variant:           planVariant || null
          });
          console.log(`[HereWork] Assinatura ${sub.status}: user ${userId} -> ${plan}`);
        } else {
          console.log(`[HereWork] subscription ${event.type} ignorada (status=${sub.status}, userId=${userId||'?'}, plan=${plan||'?'})`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = sub.metadata && sub.metadata.user_id;
        if (userId) {
          await sbAdmin('PATCH', `/rest/v1/profiles?id=eq.${userId}`, {
            plan: 'free', plan_status: 'canceled'
          });
          console.log(`[HereWork] Assinatura cancelada: user ${userId} -> free`);
        } else {
          console.log('[HereWork] subscription.deleted sem metadata.user_id — nada alterado.');
        }
        break;
      }

    default:
      console.log(`[HereWork] Evento ignorado: ${event.type}`);
  }

  /* Sempre retornar 200 para o Stripe saber que recebemos */
  return respond(res, 200, { received: true, type: event.type }, req);
};
