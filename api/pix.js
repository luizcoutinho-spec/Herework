/**
 * POST /api/pix
 *
 * Cria um PaymentIntent com método PIX via Stripe.
 * Retorna o QR Code e o código Pix Copia e Cola gerados pelo Stripe.
 *
 * Body: { amount: number, description: string }
 *
 * Resposta: {
 *   paymentIntentId, clientSecret, pixQrCode,
 *   pixQrCodeImage, pixHostedPage, expiresAt
 * }
 */

const { getStripe, respond, handleCors, toCents } = require('./_helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' });

  const {
    amount,
    description = 'HereWork — Pagamento PIX'
  } = req.body || {};

  if (!amount || isNaN(amount) || amount < 1) {
    return respond(res, 400, { error: 'Valor inválido.' });
  }

  try {
    const stripe    = getStripe();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    /* 1. Cria o PaymentIntent PIX */
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               toCents(amount),
      currency:             'brl',
      payment_method_types: ['pix'],
      description:          description,
      payment_method_options: {
        pix: { expires_after_seconds: 3600 }
      },
      metadata: { platform: 'HereWork', method: 'pix' }
    });

    /* 2. Confirma para gerar o QR Code
       NOTA: use payment_method_data (não payment_method) para PIX */
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
    });

  } catch (err) {
    console.error('[HereWork] Stripe PIX error:', err.message);

    /* PIX não habilitado na conta Stripe */
    if (err.message && err.message.includes('pix')) {
      return respond(res, 402, {
        error: 'PIX não está habilitado na sua conta Stripe. Ative em: Dashboard → Payments → Payment methods → PIX.'
      });
    }

    return respond(res, 500, {
      error: 'Erro ao criar pagamento PIX: ' + err.message
    });
  }
};
