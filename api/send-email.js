/**
 * POST /api/send-email
 *
 * Relay seguro via Resend (https://resend.com).
 * Variáveis de ambiente necessárias no Vercel:
 *   RESEND_API_KEY — chave de envio do Resend
 *   RESEND_FROM    — remetente (opcional; default: HereWork <onboarding@resend.dev>)
 *   SUPABASE_URL, SUPABASE_ANON_KEY — para validação de JWT
 *
 * Body: { to, subject, html, text }
 * Resposta sucesso: { ok: true, id: "<resend message id>" }
 * Resposta erro:    { ok: false, error: string }
 */

const { respond, handleCors } = require('./_helpers');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'Método não permitido.' }, req);

  /* ── Validar JWT do Supabase ── */
  const authHeader = (req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return respond(res, 401, { ok: false, error: 'Token de autenticação ausente.' }, req);
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
  });
  if (!userRes.ok) return respond(res, 401, { ok: false, error: 'Token inválido.' }, req);

  /* ── Validar body ── */
  const { to, subject, html, text } = req.body || {};
  if (!to || !subject) return respond(res, 400, { ok: false, error: 'Campos obrigatórios: to, subject.' }, req);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) {
    return respond(res, 400, { ok: false, error: 'E-mail destinatário inválido.' }, req);
  }

  /* ── Enviar via Resend ── */
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return respond(res, 500, { ok: false, error: 'RESEND_API_KEY não configurada.' }, req);

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:     process.env.RESEND_FROM || 'HereWork <onboarding@resend.dev>',
        to:       to,
        subject:  subject,
        html:     html || ('<p>' + subject + '</p>'),
        text:     text || subject,
        reply_to: 'contato@herework.com.br'
      })
    });

    const data = await resendRes.json();
    if (!resendRes.ok) {
      return respond(res, 500, { ok: false, error: (data && data.message) || 'Erro ao enviar e-mail via Resend.' }, req);
    }
    return respond(res, 200, { ok: true, id: data.id }, req);
  } catch (e) {
    return respond(res, 500, { ok: false, error: e.message || 'Erro ao enviar e-mail.' }, req);
  }
};
