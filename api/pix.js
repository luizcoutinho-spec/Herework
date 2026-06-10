/**
 * POST /api/pix
 *
 * Cria um PaymentIntent com método PIX via Stripe.
 * Suporta contas BR, EU, US e demais países onde o Stripe aceita PIX.
 *
 * Ref: https://docs.stripe.com/payments/pix
 *
 * Body: {
 *   amount:      number  — Valor em R$
 *   description: string  — Descrição do pagamento
 *   contractId:  string  — UUID do contrato (quando pagamento é para escrow)
 *   userId:      string  — UUID do usuário pagador
 *   planId:      string  — ID do plano (ex: 'pro', 'enterprise'; quando pagamento é de assinatura)
 * }
 */

const { getStripe, respond, handleCors, toCents } = require('./_helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, req);

  const {
    amount,
    description  = 'HereWork — Pagamento PIX',
    contractId   = '',
    userId       = '',
    planId       = ''
  } = req.body || {};

  if (!amount || isNaN(amount) || amount < 1) {
    return respond(res, 400, { error: 'Valor inválido.' }, req);
  }

  try {
    const stripe    = getStripe();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    /* 1. Cria o PaymentIntent PIX
       amount_includes_iof: 'never' = cliente paga o IOF de 3,5%
       Para absorver o IOF use 'always'                              */
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               toCents(amount),
      currency:             'brl',
      payment_method_types: ['pix'],
      description:          description,
      payment_method_options: {
        pix: {
          expires_after_seconds:  3600,
          amount_includes_iof:    'never'   /* IOF cobrado do cliente */
        }
      },
      metadata: {
        platform:    'HereWork',
        method:      'pix',
        contract_id: contractId,
        user_id:     userId,
        plan_id:     planId
      }
    });

    /* 2. Confirma para gerar o QR Code */
    const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
      payment_method_data: { type: 'pix' }
    });

    const pixData = confirmed.next_action?.pix_display_qr_code;

    return respond(res, 200, {
      paymentIntentId: confirmed.id,
      clientSecret:    confirmed.client_secret,
      status:          confirmed.status,
      pixQrCode:       pixData?.data                    || '',
      pixQrCodeImage:  pixData?.image_url_png           || '',
      pixHostedPage:   pixData?.hosted_instructions_url || '',
      expiresAt:       expiresAt
    }, req);

  } catch (err) {
    console.error('[HereWork] Stripe PIX error:', err.message);

    if (err.code === 'payment_method_unactivated' ||
        (err.message && (err.message.toLowerCase().includes('pix') ||
                         err.message.toLowerCase().includes('unactivated')))) {
      return respond(res, 402, {
        error: 'PIX não está ativado na conta Stripe. Ative em: Dashboard → Settings → Payment Methods → PIX (modo live).'
      }, req);
    }

    return respond(res, 500, {
      error: 'Erro ao criar pagamento PIX: ' + err.message
    }, req);
  }
};
