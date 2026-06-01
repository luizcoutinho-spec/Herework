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
export const config = {
  api: { bodyParser: false }
};

async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' });

  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig)    return respond(res, 400, { error: 'Stripe-Signature ausente.' });
  if (!secret) return respond(res, 500, { error: 'STRIPE_WEBHOOK_SECRET não configurado.' });

  let event;

  try {
    const stripe  = getStripe();
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[HereWork] Webhook signature error:', err.message);
    return respond(res, 400, { error: 'Assinatura inválida: ' + err.message });
  }

  /* ── Processa os eventos ── */
  console.log('[HereWork] Webhook recebido:', event.type, event.id);

  switch (event.type) {

    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`[HereWork] ✅ Pagamento confirmado: ${pi.id} — R$ ${pi.amount / 100}`);
      /*
       * Aqui você pode:
       * 1. Salvar no banco de dados que o pagamento foi confirmado
       * 2. Enviar e-mail de confirmação ao cliente
       * 3. Ativar o plano do usuário
       * 4. Liberar o escrow após aprovação
       *
       * Exemplo:
       * await db.payments.update({ stripeId: pi.id }, { status: 'confirmed' });
       * await email.send({ to: pi.metadata.email, template: 'payment_confirmed' });
       */
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const err = pi.last_payment_error;
      console.warn(`[HereWork] ❌ Pagamento falhou: ${pi.id} — ${err?.message}`);
      /* Notificar usuário, logar tentativa, etc. */
      break;
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object;
      console.warn(`[HereWork] ⚠️ Pagamento cancelado: ${pi.id}`);
      /* Liberar reservas, notificar usuário */
      break;
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object;
      console.error(`[HereWork] 🚨 Chargeback aberto: ${dispute.id} — R$ ${dispute.amount / 100}`);
      /* Alertar equipe de suporte imediatamente */
      break;
    }

    default:
      console.log(`[HereWork] Evento ignorado: ${event.type}`);
  }

  /* Sempre retornar 200 para o Stripe saber que recebemos */
  return respond(res, 200, { received: true, type: event.type });
};
