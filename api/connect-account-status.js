/**
 * POST /api/connect-account-status
 *
 * Retorna o status da conta Stripe Connect do usuário autenticado.
 * O status é sempre do próprio caller (lido via JWT) — nunca recebe user_id do body.
 *
 * 200 sem conta:   { hasAccount: false }
 * 200 com conta:   { hasAccount, accountId, transfersActive, detailsSubmitted, requirementsDue }
 * 401:             { error: 'Token inválido' | 'Token de autenticação ausente.' }
 * 404:             { error: 'Profile não encontrado' }
 * 500:             { error: '...' }
 * 502:             { error: 'Falha ao consultar conta no Stripe', stripe: '...' }
 *
 * Env vars necessárias:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *   STRIPE_SECRET_KEY_TEST
 */

const { respond, handleCors } = require('./_helpers');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);

const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY         = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, req);

  /* ── 1. Extrair JWT do usuário ── */
  const authHeader = (req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return respond(res, 401, { error: 'Token de autenticação ausente.' }, req);

  try {
    /* ── 2. Validar JWT: descobrir quem chama ── */
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + token
      }
    });
    if (!userRes.ok) return respond(res, 401, { error: 'Token inválido' }, req);
    const user     = await userRes.json();
    const callerId = user.id;

    /* ── 3. Ler profile do caller via service role ── */
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
      console.error('[connect-account-status] Supabase profile read error', profileRes.status, t);
      return respond(res, 500, { error: 'Erro ao buscar profile' }, req);
    }
    const profileRows = await profileRes.json();
    if (!profileRows || profileRows.length === 0) {
      return respond(res, 404, { error: 'Profile não encontrado' }, req);
    }
    const profile = profileRows[0];
    const acct = profile.stripe_account_id;

    /* ── 4. Sem conta Connect ainda ── */
    if (!acct) {
      return respond(res, 200, { hasAccount: false }, req);
    }

    /* ── 5. Consultar status no Stripe ── */
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
      console.error('[connect-account-status] Stripe retrieve error:', stripeErr.message);
      return respond(res, 502, { error: 'Falha ao consultar conta no Stripe', stripe: stripeErr.message }, req);
    }

  } catch (err) {
    console.error('[connect-account-status] Erro interno:', err.message);
    return respond(res, 500, { error: 'Erro interno do servidor.' }, req);
  }
};
