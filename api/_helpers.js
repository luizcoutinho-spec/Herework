/**
 * HereWork — Stripe API Helpers
 * Funções compartilhadas entre os endpoints
 */

const Stripe = require('stripe');

/**
 * Retorna instância do Stripe configurada com a secret key do ambiente
 */
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY não configurada nas variáveis de ambiente do Vercel.');
  return Stripe(key);
}

/**
 * Responde com JSON + headers CORS
 */
function respond(res, statusCode, data) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature');
  res.status(statusCode).json(data);
}

/**
 * Lida com preflight CORS (OPTIONS)
 */
function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    respond(res, 200, { ok: true });
    return true;
  }
  return false;
}

/**
 * Converte valor em R$ para centavos (Stripe usa centavos)
 */
function toCents(brl) {
  return Math.round(parseFloat(brl) * 100);
}

module.exports = { getStripe, respond, handleCors, toCents };
