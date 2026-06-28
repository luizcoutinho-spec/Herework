/**
 * /api/stripe-status
 *
 * Rota unificada (consolidação de status.js + connect-account-status.js).
 *
 * GET  ?id=pi_xxxxx
 *   Consulta o status de um PaymentIntent.
 *   Sem autenticação (usado em polling PIX — o frontend não tem JWT neste momento).
 *   Resposta: { id, status, succeeded, amount, currency, metadata }
 *
 * POST  (Authorization: Bearer <jwt>)
 *   Retorna o status da conta Stripe Connect do usuário autenticado.
 *   O status é sempre do próprio caller (lido via JWT) — nunca recebe user_id do body.
 *   Resposta 200 sem conta : { hasAccount: false }
 *   Resposta 200 com conta : { hasAccount, accountId, transfersActive, detailsSubmitted, requirementsDue }
 *
 * Env vars necessárias:
 *   STRIPE_SECRET_KEY_TEST
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (apenas para POST)
 */

const { getStripe, respond, handleCors } = require('./_helpers');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);

const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY         = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  /* ── GET — polling de PaymentIntent (sem JWT) ── */
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id || !id.startsWith('pi_')) {
      return respond(res, 400, { error: 'Payment Intent ID inválido.' }, req);
    }

    try {
      const stripeClient = getStripe();
      const pi           = await stripeClient.paymentIntents.retrieve(id);

      return respond(res, 200, {
        id:        pi.id,
        status:    pi.status,
        succeeded: pi.status === 'succeeded',
        amount:    pi.amount / 100,
        currency:  pi.currency,
        metadata:  pi.metadata || {}
      }, req);

    } catch (err) {
      console.error('[HereWork] stripe-status GET error:', err);
      return respond(res, 500, { error: 'Erro ao consultar pagamento.' }, req);
    }
  }

  /* ── POST — status da conta Stripe Connect (com JWT) ── */
  if (req.method === 'POST') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return respond(res, 401, { error: 'Token de autenticação ausente.' }, req);

    try {
      /* 1. Validar JWT: descobrir quem chama */
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'apikey':        ANON_KEY,
          'Authorization': 'Bearer ' + token
        }
      });
      if (!userRes.ok) return respond(res, 401, { error: 'Token inválido' }, req);
      const user     = await userRes.json();
      const callerId = user.id;

      /* 2. Ler profile do caller via service role */
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(callerId)}&select=id,stripe_account_id`,
        {
          headers: {
            'apikey':        SERVICE_ROLE_KEY,
            'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
          }
        }
      );
      if (!profileRes.ok) {
        const t = await profileRes.text().catch(() => '');
        console.error('[stripe-status] Supabase profile read error', profileRes.status, t);
        return respond(res, 500, { error: 'Erro ao buscar profile' }, req);
      }
      const profileRows = await profileRes.json();
      if (!profileRows || profileRows.length === 0) {
        return respond(res, 404, { error: 'Profile não encontrado' }, req);
      }
      const acct = profileRows[0].stripe_account_id;

      /* 3. Sem conta Connect ainda */
      if (!acct) {
        return respond(res, 200, { hasAccount: false }, req);
      }

      /* 4. Consultar status no Stripe */
      try {
        const account = await stripe.accounts.retrieve(acct);
        const transfersActive  = !!(account.capabilities && account.capabilities.transfers === 'active');
        const detailsSubmitted = !!account.details_submitted;
        const requirementsDue  = (account.requirements && account.requirements.currently_due) || [];

        return respond(res, 200, {
          hasAccount:       true,
          accountId:        acct,
          transfersActive:  transfersActive,
          detailsSubmitted: detailsSubmitted,
          requirementsDue:  requirementsDue
        }, req);
      } catch (stripeErr) {
        console.error('[stripe-status] Stripe retrieve error:', stripeErr.message);
        return respond(res, 502, { error: 'Falha ao consultar conta no Stripe', stripe: stripeErr.message }, req);
      }

    } catch (err) {
      console.error('[stripe-status] Erro interno:', err.message);
      return respond(res, 500, { error: 'Erro interno do servidor.' }, req);
    }
  }

  return respond(res, 405, { error: 'Método não permitido.' }, req);
};
