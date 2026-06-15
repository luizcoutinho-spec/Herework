/**
 * HereWork — Stripe API Helpers
 * Funções compartilhadas entre os endpoints
 */

const Stripe = require('stripe');

/**
 * Retorna instância do Stripe configurada com a secret key do ambiente
 * TEMP (fase de testes): usa STRIPE_SECRET_KEY_TEST.
 * GO-LIVE: trocar para STRIPE_SECRET_KEY (sk_live_) e validar prefixo no boot.
 */
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY_TEST;
  if (!key) throw new Error('STRIPE_SECRET_KEY_TEST não configurada nas variáveis de ambiente do Vercel.');
  return Stripe(key);
}

/* Origens confiáveis que podem chamar esta API */
const ALLOWED_ORIGINS = [
  'https://herework.vercel.app',
  'https://herework.com.br',
  'https://www.herework.com.br',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500'
];

/**
 * Responde com JSON + headers CORS restritos por origem
 */
function respond(res, statusCode, data, req) {
  res.setHeader('Content-Type', 'application/json');

  /* CORS: reflete a origem somente se for confiável; caso contrário bloqueia */
  var origin = (req && req.headers && req.headers.origin) || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin',  origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    /* Chamada server-to-server sem Origin: permite (ex: Stripe webhook) */
    res.setHeader('Access-Control-Allow-Origin', 'https://herework.vercel.app');
  }
  /* Se a origem não for confiável, o header não é emitido → browser bloqueia */

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(statusCode).json(data);
}

/**
 * Lida com preflight CORS (OPTIONS)
 */
function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    respond(res, 200, { ok: true }, req);
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
