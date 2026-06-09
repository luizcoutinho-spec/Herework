/**
 * POST /api/send-email
 *
 * Relay seguro para a API do Resend.
 * A RESEND_API_KEY fica em variável de ambiente no Vercel — nunca exposta no HTML.
 *
 * Body: {
 *   to:      string   — destinatário (ex: "user@email.com")
 *   subject: string   — assunto
 *   html:    string   — corpo HTML
 *   text:    string   — corpo texto simples (fallback)
 * }
 *
 * Resposta sucesso: { ok: true, id: "resend_id" }
 * Resposta erro:    { ok: false, error: string }
 */

const { respond, handleCors } = require('./_helpers');

const FROM    = 'HereWork <onboarding@resend.dev>';   /* Trocar por contato@herework.com.br após verificar domínio */
const REPLY_TO = 'contato@herework.com.br';

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'Método não permitido.' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return respond(res, 500, { ok: false, error: 'RESEND_API_KEY não configurada.' });

  const { to, subject, html, text } = req.body || {};

  if (!to || !subject) {
    return respond(res, 400, { ok: false, error: 'Campos obrigatórios: to, subject.' });
  }

  /* Valida formato básico do e-mail */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) {
    return respond(res, 400, { ok: false, error: 'E-mail destinatário inválido.' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        from:     FROM,
        to:       [to],
        reply_to: REPLY_TO,
        subject:  subject,
        html:     html || '<p>' + subject + '</p>',
        text:     text || subject
      })
    });

    const data = await r.json();

    if (data.id) {
      return respond(res, 200, { ok: true, id: data.id });
    }

    /* Rate limit — retornar 429 para o frontend tentar novamente */
    if (r.status === 429) {
      return respond(res, 429, { ok: false, error: 'Rate limit. Tente novamente em instantes.' });
    }

    return respond(res, r.status || 500, { ok: false, error: data.message || 'Erro desconhecido.' });

  } catch (e) {
    return respond(res, 500, { ok: false, error: e.message || 'Erro interno.' });
  }
};
