/**
 * GET /api/status?id=pi_xxxxx
 *
 * Consulta o status de um PaymentIntent.
 * Usado pelo frontend para polling após PIX (aguarda confirmação).
 *
 * Resposta: {
 *   id:          string
 *   status:      'requires_payment_method' | 'requires_confirmation' |
 *                'requires_action' | 'processing' | 'succeeded' | 'canceled'
 *   succeeded:   boolean
 *   amount:      number   — em R$
 *   currency:    string
 * }
 */

const { getStripe, respond, handleCors } = require('./_helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return respond(res, 405, { error: 'Método não permitido.' });

  const { id } = req.query;
  if (!id || !id.startsWith('pi_')) {
    return respond(res, 400, { error: 'Payment Intent ID inválido.' });
  }

  try {
    const stripe = getStripe();
    const pi     = await stripe.paymentIntents.retrieve(id);

    return respond(res, 200, {
      id:        pi.id,
      status:    pi.status,
      succeeded: pi.status === 'succeeded',
      amount:    pi.amount / 100,
      currency:  pi.currency,
      metadata:  pi.metadata || {}
    });

  } catch (err) {
    console.error('[HereWork] Status error:', err);
    return respond(res, 500, { error: 'Erro ao consultar pagamento.' });
  }
};
