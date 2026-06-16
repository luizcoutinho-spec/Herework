/**
 * POST /api/release-payment
 *
 * Libera o pagamento ao freelancer após aprovação do contrato.
 * Calcula comissão server-side (plano do freelancer + recorrência real),
 * cria Stripe Transfer para a conta Connect do freelancer e grava
 * escrow_released=true no contrato.
 *
 * Body:  { contractId: string }
 * 200:   { success, transferId, amount, commission, commissionPct, recurrent, freelancerAccount }
 * 400:   { error: 'contractId obrigatório' }
 * 401:   { error: 'Token inválido' | 'Token de autenticação ausente.' }
 * 403:   { error: 'Apenas o cliente pode liberar' }
 * 404:   { error: 'Contrato não encontrado' | 'Freelancer não encontrado' }
 * 409:   { error: 'Contrato não está aprovado (status: ...)' | 'Pagamento já liberado' }
 * 422:   { error: 'Freelancer sem conta Connect configurada' | 'Valor de repasse inválido' }
 * 502:   { error: 'Falha ao processar repasse', stripe: '...' }
 * 500:   { error: '...' }
 *
 * Env vars necessárias:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *   STRIPE_SECRET_KEY_TEST  (mesma chave de create-connect-account.js)
 *
 * Obs: contracts precisa da coluna stripe_transfer_id TEXT (migration pendente).
 */

const { respond, handleCors } = require('./_helpers');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);

const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY         = process.env.SUPABASE_ANON_KEY;

const RATES = {
  free:       { novo: 0.18, recorrente: 0.12 },
  pro:        { novo: 0.12, recorrente: 0.08 },
  enterprise: { novo: 0.08, recorrente: 0.05 }
};

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
    /* ── 3. Validar JWT: descobrir quem chama ── */
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
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}&select=id,client_id,freelancer_id,status,value,escrow_released,stripe_payment_intent_id`,
      {
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
        }
      }
    );
    if (!contractRes.ok) {
      const t = await contractRes.text().catch(() => '');
      console.error('[release-payment] Supabase contract read error', contractRes.status, t);
      return respond(res, 500, { error: 'Erro ao buscar contrato' }, req);
    }
    const contractRows = await contractRes.json();
    if (!contractRows || contractRows.length === 0) {
      return respond(res, 404, { error: 'Contrato não encontrado' }, req);
    }
    const contrato = contractRows[0];

    /* ── 5. Autorização ── */
    if (contrato.client_id !== callerId) {
      return respond(res, 403, { error: 'Apenas o cliente pode liberar' }, req);
    }

    /* ── 6. Estado ── */
    if (contrato.status !== 'completed') {
      return respond(res, 409, { error: 'Contrato não está aprovado (status: ' + contrato.status + ')' }, req);
    }

    /* ── 7. LOCK atômico: PATCH condicional escrow_released=eq.false → só 1 req passa ── */
    const lockRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contrato.id)}&escrow_released=eq.false`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({ escrow_released: true })
      }
    );
    const lockedRows = lockRes.ok ? await lockRes.json() : [];
    if (!lockedRows || lockedRows.length === 0) {
      return respond(res, 409, { error: 'Pagamento já liberado ou em processamento' }, req);
    }

    /* ── 8. Ler profile do freelancer ── */
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(contrato.freelancer_id)}&select=id,stripe_account_id,plan`,
      {
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
        }
      }
    );
    if (!profileRes.ok) {
      const t = await profileRes.text().catch(() => '');
      console.error('[release-payment] Supabase profile read error', profileRes.status, t);
      return respond(res, 500, { error: 'Erro ao buscar profile do freelancer' }, req);
    }
    const profileRows = await profileRes.json();
    if (!profileRows || profileRows.length === 0) {
      return respond(res, 404, { error: 'Freelancer não encontrado' }, req);
    }
    const profile = profileRows[0];
    if (!profile.stripe_account_id) {
      return respond(res, 422, { error: 'Freelancer sem conta Connect configurada' }, req);
    }

    /* ── 9. Recorrência (server-side) ── */
    const recurrenceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?client_id=eq.${encodeURIComponent(contrato.client_id)}&freelancer_id=eq.${encodeURIComponent(contrato.freelancer_id)}&status=eq.completed&id=neq.${encodeURIComponent(contrato.id)}&select=id&limit=1`,
      {
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
        }
      }
    );
    const recurrenceRows = recurrenceRes.ok ? await recurrenceRes.json() : [];
    const isRecurrent = Array.isArray(recurrenceRows) && recurrenceRows.length > 0;

    /* ── 10. Comissão server-side ── */
    const plan = (['free', 'pro', 'enterprise'].indexOf(profile.plan) !== -1) ? profile.plan : 'free';
    const rate = RATES[plan][isRecurrent ? 'recorrente' : 'novo'];
    const valueNum   = Number(contrato.value);
    const commission = Math.round(valueNum * rate * 100) / 100;
    const amountReais = valueNum - commission;
    const amountCents = Math.round(amountReais * 100);
    if (amountCents <= 0) {
      return respond(res, 422, { error: 'Valor de repasse inválido' }, req);
    }

    /* ── 11. Obter charge original (BR exige source_transaction no transfer) ── */
    if (!contrato.stripe_payment_intent_id) {
      return respond(res, 400, { error: 'Contrato sem pagamento associado (sem payment_intent).' }, req);
    }
    const pi   = await stripe.paymentIntents.retrieve(contrato.stripe_payment_intent_id);
    const chId = pi && pi.latest_charge ? pi.latest_charge : null;
    if (!chId) {
      return respond(res, 400, { error: 'Não foi possível localizar a cobrança original (charge) do pagamento.' }, req);
    }

    /* ── 12. Stripe Transfer (idempotência via idempotencyKey) ── */
    let transfer;
    try {
      transfer = await stripe.transfers.create(
        {
          amount:             amountCents,
          currency:           'brl',
          destination:        profile.stripe_account_id,
          source_transaction: chId,
          metadata: {
            contract_id:     contrato.id,
            freelancer_id:   contrato.freelancer_id,
            plan:            plan,
            recurrent:       String(isRecurrent),
            commission_pct:  String(Math.round(rate * 100)),
            value:           String(valueNum)
          }
        },
        { idempotencyKey: 'release_' + contrato.id + '_' + amountCents }
      );
    } catch (stripeErr) {
      // Reverter lock — Transfer NÃO ocorreu; contrato não pode ficar travado
      console.error('[release-payment] Stripe transfer error — revertendo lock:', stripeErr.message);
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contrato.id)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey':        SERVICE_ROLE_KEY,
              'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
              'Content-Type':  'application/json'
            },
            body: JSON.stringify({ escrow_released: false })
          }
        );
        console.log('[release-payment] Lock revertido para contrato', contrato.id);
      } catch (revertErr) {
        console.error('[release-payment] CRÍTICO: falha ao reverter lock — contrato pode travar:', contrato.id, revertErr.message);
      }
      const errCode = stripeErr.code || (stripeErr.raw && stripeErr.raw.code) || '';
      const errMsg  = stripeErr.message || '';
      let httpStatus, friendlyError;
      if (/capability|destination.*not.*enabl|account.*not.*enabl|no such.*account|account.*invalid/i.test(errMsg) ||
          /^(account_invalid|transfer_not_allowed|destination_capability_missing|no_account)$/.test(errCode)) {
        httpStatus    = 422;
        friendlyError = 'A conta de recebimento do freelancer ainda está sendo verificada pelo Stripe. Aguarde a conclusão do onboarding e tente novamente.';
      } else if (/source_transaction|charge.*already.*transfer|already.*transfer|no such charge/i.test(errMsg) ||
                 /^(charge_already_refunded|source_transfer_already_paid_out)$/.test(errCode)) {
        httpStatus    = 422;
        friendlyError = 'O pagamento original não está mais disponível para repasse automático. Contate o suporte.';
      } else if (/idempoten/i.test(errMsg) || /^idempotency_key_in_use$/.test(errCode)) {
        httpStatus    = 409;
        friendlyError = 'Já existe uma solicitação de repasse em andamento ou concluída para este contrato.';
      } else if (/balance_insufficient|insufficient.*fund|insufficient.*balance/i.test(errMsg) ||
                 /^balance_insufficient$/.test(errCode)) {
        httpStatus    = 422;
        friendlyError = 'Saldo insuficiente na plataforma para processar o repasse. Contate o suporte.';
      } else {
        httpStatus    = 502;
        friendlyError = 'Não foi possível concluir o repasse no momento. Tente novamente em alguns minutos.';
      }
      console.error('[release-payment] Stripe transfer falhou:', {
        message: stripeErr.message, code: errCode, type: stripeErr.type, contract: contrato.id
      });
      const errBody = { error: friendlyError };
      if (errCode) errBody.code = errCode;
      return respond(res, httpStatus, errBody, req);
    }

    /* ── 13. Gravar escrow_released + stripe_transfer_id (service role) ── */
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contrato.id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({ stripe_transfer_id: transfer.id })
      }
    );
    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      /* CRÍTICO: transfer JÁ ocorreu — logar transfer.id para reconciliação manual */
      console.error('[release-payment] PATCH failed AFTER transfer — reconcile manually!',
        'transfer_id:', transfer.id, 'contract_id:', contrato.id, 'error:', t);
      return respond(res, 500, { error: 'Repasse processado mas falha ao gravar no banco — contate suporte.' }, req);
    }

    /* ── 14. Sucesso ── */
    return respond(res, 200, {
      success:          true,
      transferId:       transfer.id,
      amount:           amountReais,
      commission:       commission,
      commissionPct:    Math.round(rate * 100),
      recurrent:        isRecurrent,
      freelancerAccount: profile.stripe_account_id
    }, req);

  } catch (err) {
    console.error('[release-payment] Erro interno:', err.message);
    return respond(res, 500, { error: 'Erro interno do servidor.' }, req);
  }
};
