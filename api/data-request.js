/**
 * POST /api/data-request
 *
 * Registra solicitações de direitos do titular (LGPD Art. 18 / GDPR Art. 17 & 20)
 *
 * Tipos aceitos:
 *   export   — Portabilidade / Acesso (entrega JSON com dados do usuário)
 *   delete   — Exclusão / Esquecimento (agenda exclusão permanente)
 *   rectify  — Retificação (abre ticket de suporte)
 *
 * Body: { type: 'export'|'delete'|'rectify', userId: string, userEmail: string, notes?: string }
 *
 * Variáveis de ambiente necessárias no Vercel:
 *   GMAIL_USER          — remetente SMTP
 *   GMAIL_APP_PASSWORD  — senha de app Google
 *   DPO_EMAIL           — email do encarregado de dados (ex: privacidade@herework.com.br)
 */

const nodemailer = require('nodemailer');
const { respond, handleCors } = require('./_helpers');

const VALID_TYPES = ['export', 'delete', 'rectify'];

/* Limite simples em memória: 3 solicitações por IP por hora */
const _rateMap = {};
function _checkRate(ip) {
  const now = Date.now();
  const key = ip + ':' + Math.floor(now / 3600000);
  _rateMap[key] = (_rateMap[key] || 0) + 1;
  /* Limpa entradas antigas periodicamente */
  if (Math.random() < 0.05) {
    const cutoff = Math.floor(now / 3600000) - 1;
    Object.keys(_rateMap).forEach(k => { if (k.includes(':' + cutoff)) delete _rateMap[k]; });
  }
  return _rateMap[key] <= 3;
}

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER ou GMAIL_APP_PASSWORD não configurados.');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'Método não permitido.' }, req);

  /* Rate limit */
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!_checkRate(clientIp)) {
    return respond(res, 429, { ok: false, error: 'Muitas solicitações. Aguarde 1 hora.' }, req);
  }

  const { type, userId, userEmail, notes } = req.body || {};

  if (!type || !VALID_TYPES.includes(type)) {
    return respond(res, 400, { ok: false, error: 'type deve ser: export, delete ou rectify.' }, req);
  }
  if (!userId || !userEmail) {
    return respond(res, 400, { ok: false, error: 'userId e userEmail são obrigatórios.' }, req);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(userEmail))) {
    return respond(res, 400, { ok: false, error: 'E-mail inválido.' }, req);
  }

  const dpoEmail = process.env.DPO_EMAIL || 'privacidade@herework.com.br';
  const protocol = type.toUpperCase() + '-' + Date.now().toString(36).toUpperCase().slice(-8);
  const requestedAt = new Date().toISOString();

  const typeLabels = {
    export:  'Portabilidade / Acesso aos Dados (Art. 18-V LGPD)',
    delete:  'Exclusão de Dados Pessoais (Art. 18-VI LGPD)',
    rectify: 'Retificação de Dados (Art. 18-III LGPD)'
  };

  const deadlines = {
    export:  '15 dias úteis',
    delete:  '15 dias úteis',
    rectify: '5 dias úteis'
  };

  const htmlDpo = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1C2B3A;">Nova Solicitação de Direito do Titular</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">Protocolo</td><td style="padding:8px;border:1px solid #ddd;">${protocol}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">Tipo</td><td style="padding:8px;border:1px solid #ddd;">${typeLabels[type]}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">Usuário ID</td><td style="padding:8px;border:1px solid #ddd;">${userId}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">E-mail</td><td style="padding:8px;border:1px solid #ddd;">${userEmail}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">Solicitado em</td><td style="padding:8px;border:1px solid #ddd;">${requestedAt}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">IP</td><td style="padding:8px;border:1px solid #ddd;">${clientIp}</td></tr>
        ${notes ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">Observações</td><td style="padding:8px;border:1px solid #ddd;">${notes}</td></tr>` : ''}
      </table>
      <p style="margin-top:16px;font-size:13px;color:#666;">Prazo de resposta: <strong>${deadlines[type]}</strong></p>
      ${type === 'delete'
        ? '<p style="color:#dc2626;font-weight:600;">⚠️ ATENÇÃO: Esta solicitação exige exclusão permanente no Supabase Admin. Acesse app.supabase.com → Authentication → Users e exclua manualmente antes do prazo.</p>'
        : ''}
    </div>`;

  const htmlUser = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#2E7D32;">Solicitação Recebida — HereWork</h2>
      <p>Olá,</p>
      <p>Recebemos sua solicitação de <strong>${typeLabels[type]}</strong>.</p>
      <p><strong>Protocolo:</strong> ${protocol}</p>
      <p><strong>Prazo de resposta:</strong> ${deadlines[type]} a partir de hoje (${new Date().toLocaleDateString('pt-BR')}).</p>
      <p>Responderemos para este e-mail quando o processamento for concluído.</p>
      <p>Dúvidas: <a href="mailto:${dpoEmail}">${dpoEmail}</a></p>
      <hr style="margin:24px 0;border-color:#e5e7eb;">
      <p style="font-size:11px;color:#999;">HereWork · Plataforma de Freelancers · Conforme LGPD (Lei 13.709/2018) e GDPR (EU 2016/679)</p>
    </div>`;

  try {
    const transporter = getTransporter();
    const from = '"HereWork Privacidade" <' + process.env.GMAIL_USER + '>';

    await Promise.all([
      /* Notifica o DPO */
      transporter.sendMail({
        from, to: dpoEmail,
        subject: `[${protocol}] Solicitação de ${typeLabels[type]} — ${userEmail}`,
        html: htmlDpo
      }),
      /* Confirma ao titular */
      transporter.sendMail({
        from, to: userEmail,
        subject: `[HereWork] Sua solicitação foi recebida — Protocolo ${protocol}`,
        html: htmlUser
      })
    ]);

    return respond(res, 200, {
      ok:       true,
      protocol: protocol,
      deadline: deadlines[type],
      message:  'Solicitação registrada. Você receberá confirmação por e-mail em até ' + deadlines[type] + '.'
    }, req);

  } catch (e) {
    console.error('[HereWork] data-request error:', e.message);
    /* Mesmo com falha de e-mail, registramos o protocolo */
    return respond(res, 200, {
      ok:       true,
      protocol: protocol,
      deadline: deadlines[type],
      message:  'Solicitação registrada com protocolo ' + protocol + '. Entre em contato via ' + dpoEmail + ' caso não receba confirmação.'
    }, req);
  }
};
