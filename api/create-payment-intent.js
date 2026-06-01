/**
 * POST /api/create-payment-intent
 *
 * Cria e confirma um PaymentIntent para pagamento com cartão de crédito.
 * O frontend envia o paymentMethodId gerado pelo Stripe.js (createPaymentMethod).
 *
 * Body: {
 *   paymentMethodId: string   — ID do PaymentMethod criado pelo Stripe.js no frontend
 *   amount:          number   — Valor em R$ (ex: 149.00)
 *   currency:        string   — "brl" (padrão)
 *   description:     string   — Descrição do pagamento
 *   planId:          string   — ID do plano (opcional)
 *   installments:    number   — Parcelas (1–12)
 * }
 *
 * Resposta sucesso: { success: true, paymentIntentId, status, last4, brand }
 * Resposta 3DS:     { requiresAction: true, clientSecret }
 * Resposta erro:    { error: string }
 */

const { getStripe, respond, handleCors, toCents } = require('./_helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' });

  const {
    paymentMethodId,
    amount,
    currency     = 'brl',
    description  = 'HereWork — Pagamento',
    planId       = '',
    installments = 1
  } = req.body || {};

  /* Validações básicas */
  if (!paymentMethodId) return respond(res, 400, { error: 'paymentMethodId é obrigatório.' });
  if (!amount || isNaN(amount) || amount < 1) return respond(res, 400, { error: 'Valor inválido.' });

  try {
    const stripe = getStripe();
    const amountCents = toCents(amount);

    /* Cria e confirma o PaymentIntent */
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               amountCents,
      currency:             currency,
      payment_method:       paymentMethodId,
      description:          description,
      confirm:              true,
      /* Retorna ao frontend se precisar de 3D Secure */
      return_url:           'https://herework.com.br/pagamento-confirmado',
      automatic_payment_methods: { enabled: false },
      payment_method_types: ['card'],
      metadata: {
        planId:       planId,
        installments: String(installments),
        platform:     'HereWork'
      }
    });

    /* Pagamento confirmado imediatamente */
    if (paymentIntent.status === 'succeeded') {
      const card = paymentIntent.payment_method_details?.card;
      return respond(res, 200, {
        success:         true,
        paymentIntentId: paymentIntent.id,
        status:          'succeeded',
        last4:           card?.last4 || '',
        brand:           card?.brand || '',
        amount:          amount
      });
    }

    /* 3D Secure necessário */
    if (paymentIntent.status === 'requires_action') {
      return respond(res, 200, {
        requiresAction: true,
        clientSecret:   paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    /* Outros status */
    return respond(res, 200, {
      success:         false,
      status:          paymentIntent.status,
      paymentIntentId: paymentIntent.id
    });

  } catch (err) {
    console.error('[HereWork] Stripe error:', err);

    /* Erros de cartão (fundos insuficientes, cartão recusado, etc.) */
    if (err.type === 'StripeCardError') {
      return respond(res, 402, { error: err.message, code: err.code });
    }

    return respond(res, 500, { error: 'Erro ao processar pagamento. Tente novamente.' });
  }
};
