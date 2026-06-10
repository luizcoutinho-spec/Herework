/**
 * POST /api/send-email
 *
 * Relay seguro via Gmail SMTP (Nodemailer).
 * Variáveis de ambiente necessárias no Vercel:
 *   GMAIL_USER         — ex: luiz.coutinho@brandvakt.com
 *   GMAIL_APP_PASSWORD — Senha de app do Google (16 caracteres)
 *
 * Body: { to, subject, html, text }
 * Resposta sucesso: { ok: true, id: "<messageId>" }
 * Resposta erro:    { ok: false, error: string }
 */

const nodemailer = require('nodemailer');
const { respond, handleCors } = require('./_helpers');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER ou GMAIL_APP_PASSWORD não configurados.');
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return _transporter;
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'Método não permitido.' }, req);

  const { to, subject, html, text } = req.body || {};
  if (!to || !subject) return respond(res, 400, { ok: false, error: 'Campos obrigatórios: to, subject.' }, req);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) {
    return respond(res, 400, { ok: false, error: 'E-mail destinatário inválido.' }, req);
  }

  try {
    const transporter = getTransporter();
    const from = '"HereWork" <' + process.env.GMAIL_USER + '>';

    const info = await transporter.sendMail({
      from,
      to,
      replyTo: from,
      subject,
      html:    html || '<p>' + subject + '</p>',
      text:    text || subject
    });

    return respond(res, 200, { ok: true, id: info.messageId }, req);
  } catch (e) {
    return respond(res, 500, { ok: false, error: e.message || 'Erro ao enviar e-mail.' }, req);
  }
};
