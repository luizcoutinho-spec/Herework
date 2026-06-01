/**
 * POST /api/pix
 *
 * Cria um PaymentIntent com método PIX via Stripe.
 * Retorna o QR Code e o código Pix Copia e Cola gerados pelo Stripe.
 *
 * Nota: Stripe suporta PIX no Brasil desde 2022.
 * O QR code expira em 1 hora (configurável até 24h).
 *
 * Body: {
 *   amount:      number  — Valor em R$
 *   description: string  — Descrição (ex: "Plano Profissional HereWork")
 * }
 *
 * Resposta: {
 *   paymentIntentId:  string
 *   clientSecret:     string   — Para confirmar no frontend
 *   pixQrCode:        string   — Código Pix Copia e Cola (texto)
 *   pixQrCodeImage:   string   — URL da imagem PNG do QR Code (Stripe CDN)
 *   pixHostedPage:    string   — Link para página de pagamento hospedada
 *   expiresAt:        number   — Timestamp de expiração
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
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; /* 1 hora */

    const paymentIntent = await stripe.paymentIntents.create({
      amount:               toCents(amount),
      currency:             'brl',
      payment_method_types: ['pix'],
      description:          description,
      payment_method_options: {
        pix: {
          expires_after_seconds: 3600  /* QR Code válido por 1 hora */
        }
      },
      metadata: {
        platform: 'HereWork',
        method:   'pix'
      }
    });

    /* Confirma o PaymentIntent para gerar o QR Code */
    const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
      payment_method: { type: 'pix' }
    });

    /* Extrai os dados do PIX da resposta do Stripe */
    const pixData = confirmed.next_action?.pix_display_qr_code;

    return respond(res, 200, {
      paymentIntentId: confirmed.id,
      clientSecret:    confirmed.client_secret,
      status:          confirmed.status,
      pixQrCode:       pixData?.data              || '',   /* Pix Copia e Cola */
      pixQrCodeImage:  pixData?.image_url_png     || '',   /* Imagem PNG do QR */
      pixHostedPage:   pixData?.hosted_instructions_url || '',
      expiresAt:       expiresAt
    });

  } catch (err) {
    console.error('[HereWork] Stripe PIX error:', err);
    return respond(res, 500, { error: 'Erro ao criar pagamento PIX. Tente novamente.' });
  }
};
