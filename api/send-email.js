/**
 * POST /api/send-email
 *
 * Relay seguro via Resend (https://resend.com).
 * Variáveis de ambiente necessárias no Vercel:
 *   RESEND_API_KEY             — chave de envio do Resend
 *   RESEND_FROM                — remetente (opcional; default: HereWork <onboarding@resend.dev>)
 *   SUPABASE_URL               — URL do projeto Supabase
 *   SUPABASE_ANON_KEY          — para validação de JWT
 *   SUPABASE_SERVICE_ROLE_KEY  — para busca de email por userId
 *
 * Body: { userId?, to?, subject, html, text }
 *   userId → backend busca o email via service role (preferido)
 *   to     → email direto (compatibilidade — usado enquanto o front não migrar)
 * Resposta sucesso: { ok: true, id: "<resend message id>" }
 * Resposta erro:    { ok: false, error: string }
 */

const { respond, handleCors } = require('./_helpers');

const SUPABASE_URL      = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY          = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  /* ── Resolver destinatário ── */
  const { userId, to: toRaw, subject, html, text } = req.body || {};
  if (!userId && !toRaw) {
    return respond(res, 400, { ok: false, error: 'Obrigatório: userId ou to.' }, req);
  }
  if (!subject) return respond(res, 400, { ok: false, error: 'Campo obrigatório: subject.' }, req);

  let recipientEmail;

  if (userId) {
    /* Buscar email via service role — front nunca lê email de terceiros */
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=email`,
      { headers: { 'apikey': SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + SERVICE_ROLE_KEY } }
    );
    if (!profileRes.ok) {
      return respond(res, 500, { ok: false, error: 'Erro ao buscar destinatário.' }, req);
    }
    const profiles = await profileRes.json();
    recipientEmail = profiles && profiles[0] && profiles[0].email;
    if (!recipientEmail) {
      return respond(res, 404, { ok: false, error: 'Destinatário não encontrado.' }, req);
    }
  } else {
    /* Compatibilidade: 'to' passado diretamente */
    recipientEmail = toRaw;
  }

  /* ── Validar formato do email resolvido ── */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipientEmail))) {
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
        to:       recipientEmail,
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
