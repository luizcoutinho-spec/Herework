/**
 * POST /api/cancel-contract
 *
 * Cliente pede estorno de um contrato que ainda não foi aceito pelo freelancer.
 * Só permitido em status 'pending_acceptance' (antes do freelancer confirmar).
 * Estorna 95% do value no Stripe; plataforma retém 5%.
 * Após estorno: contrato vira 'cancelled' + refunded_at = now().
 *
 * Body:  { contractId: string }
 * 200:   { ok: true, refundId: string, amount: number, status: 'cancelled' }
 * 400:   { error: 'contractId obrigatório' | 'Contrato sem pagamento associado' }
 * 401:   { error: 'Token inválido' | 'Token de autenticação ausente.' }
 * 403:   { error: 'Apenas o cliente pode pedir estorno' }
 * 404:   { error: 'Contrato não encontrado' }
 * 409:   { error: 'Estorno não permitido (status atual: ...)...' | 'Estorno já realizado' }
 * 502:   { error: 'Falha ao processar estorno', stripe: '...' }
 * 500:   { error: '...' }
 *
 * Env vars necessárias:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *   STRIPE_SECRET_KEY_TEST
 */

'use strict';

const { respond, handleCors } = require('./_helpers');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);

const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY         = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, req);

  /* ── 1. Validar body ── */
  const { contractId } = req.body || {};
  if (!contractId) return respond(res, 400, { error: 'contractId obrigatório' }, req);

  /* ── 2. Extrair JWT do usuário ── */
  const authHeader = (req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return respond(res, 401, { error: 'Token de autenticação ausente.' }, req);

  try {
    /* ── 3. Validar JWT: callerId vem sempre do token, nunca do body ── */
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + token
      }
    });
    if (!userRes.ok) return respond(res, 401, { error: 'Token inválido' }, req);
    const user     = await userRes.json();
    const callerId = user.id;

    /* ── 4. Ler contrato via service role ── */
    const contractRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}&select=id,client_id,freelancer_id,status,value,escrow_released,stripe_payment_intent_id,refunded_at&limit=1`,
      {
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
        }
      }
    );
    if (!contractRes.ok) {
      const t = await contractRes.text().catch(() => '');
      console.error('[cancel-contract] Supabase read error', contractRes.status, t);
      return respond(res, 500, { error: 'Erro ao buscar contrato' }, req);
    }
    const rows = await contractRes.json();
    if (!rows || rows.length === 0) return respond(res, 404, { error: 'Contrato não encontrado' }, req);
    const contract = rows[0];

    /* ── 5. Autorização: só o cliente pode pedir estorno ── */
    if (contract.client_id !== callerId) {
      return respond(res, 403, { error: 'Apenas o cliente pode pedir estorno' }, req);
    }

    /* ── 6. Estado: só permitido em pending_acceptance ── */
    if (contract.status !== 'pending_acceptance') {
      return respond(res, 409, {
        error: 'Estorno não permitido (status atual: ' + contract.status + '). Só é possível antes do freelancer aceitar.'
      }, req);
    }

    /* ── 7. Idempotência: estorno já realizado? ── */
    if (contract.refunded_at) {
      return respond(res, 409, { error: 'Estorno já realizado' }, req);
    }

    /* ── 8. Guarda: payment_intent obrigatório ── */
    if (!contract.stripe_payment_intent_id) {
      return respond(res, 400, { error: 'Contrato sem pagamento associado' }, req);
    }

    /* ── 9. Calcular valor do estorno: 95% em centavos ── */
    const refundAmount = Math.round(Number(contract.value) * 0.95 * 100);

    /* ── 10. Criar estorno no Stripe (idempotência via idempotencyKey) ── */
    let refund;
    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: contract.stripe_payment_intent_id,
          amount:         refundAmount
        },
        { idempotencyKey: 'refund_' + contract.id }
      );
    } catch (stripeErr) {
      console.error('[cancel-contract] Stripe refund error:', stripeErr.message);
      return respond(res, 502, { error: 'Falha ao processar estorno', stripe: stripeErr.message }, req);
    }

    /* ── 11. Gravar: status='cancelled', refunded_at=now() (service role) ── */
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({
          status:      'cancelled',
          refunded_at: new Date().toISOString()
        })
      }
    );
    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      /* CRÍTICO: refund JÁ ocorreu — logar refund.id para reconciliação manual */
      console.error('[cancel-contract] PATCH failed AFTER refund — reconcile manually!',
        'refund_id:', refund.id, 'contract_id:', contractId, 'error:', t);
      return respond(res, 500, { error: 'Estorno processado mas falha ao gravar no banco — contate o suporte.' }, req);
    }

    /* ── 12. Sucesso ── */
    return respond(res, 200, {
      ok:       true,
      refundId: refund.id,
      amount:   refundAmount,
      status:   'cancelled'
    }, req);

  } catch (err) {
    console.error('[cancel-contract] Erro interno:', err.message);
    return respond(res, 500, { error: 'Erro interno do servidor.' }, req);
  }
};
