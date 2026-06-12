/**
 * POST /api/confirm-contract
 *
 * Freelancer confirma o contrato (pending_acceptance → active).
 * Valida o JWT do chamador — apenas o freelancer do contrato pode confirmar.
 * Aceita somente status 'pending_acceptance'.
 * NÃO altera escrow_released nem paid_at.
 *
 * Body:  { contractId: string }
 * 200:   { ok: true, status: 'active', contractId }
 * 400:   { error: 'contractId obrigatório' }
 * 401:   { error: 'Token inválido' | 'Token de autenticação ausente.' }
 * 403:   { error: 'Apenas o freelancer pode confirmar' }
 * 404:   { error: 'Contrato não encontrado' }
 * 409:   { error: 'Confirmação não permitida (status atual: ...)' }
 * 500:   { error: '...' }
 *
 * Env vars necessárias:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

const { respond, handleCors } = require('./_helpers');

const SUPABASE_URL     = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY         = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, req);

  /* ── 1. Validar body ── */
  const { contractId } = req.body || {};
  if (!contractId) return respond(res, 400, { error: 'contractId obrigatório' }, req);

  /* ── 2. Extrair JWT do usuário ── */
  const authHeader = (req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return respond(res, 401, { error: 'Token de autenticação ausente.' }, req);

  try {
    /* ── 3. Validar JWT: descobrir quem chama ── */
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + token
      }
    });
    if (!userRes.ok) return respond(res, 401, { error: 'Token inválido' }, req);
    const user     = await userRes.json();
    const callerId = user.id;

    /* ── 4. Ler contrato via service role ── */
    const contractRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}&select=id,client_id,freelancer_id,status`,
      {
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY
        }
      }
    );
    if (!contractRes.ok) {
      const t = await contractRes.text().catch(() => '');
      console.error('[confirm-contract] Supabase read error', contractRes.status, t);
      return respond(res, 500, { error: 'Erro ao buscar contrato' }, req);
    }
    const rows = await contractRes.json();
    if (!rows || rows.length === 0) return respond(res, 404, { error: 'Contrato não encontrado' }, req);
    const contract = rows[0];

    /* ── 5. Autorização ── */
    if (contract.freelancer_id !== callerId) {
      return respond(res, 403, { error: 'Apenas o freelancer pode confirmar' }, req);
    }
    if (contract.status !== 'pending_acceptance') {
      return respond(res, 409, { error: 'Confirmação não permitida (status atual: ' + contract.status + ')' }, req);
    }

    /* ── 6. Gravar: status='active', started_at=now() ── */
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({
          status:     'active',
          started_at: new Date().toISOString()
        })
      }
    );
    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      console.error('[confirm-contract] Supabase patch error', patchRes.status, t);
      return respond(res, 500, { error: 'Falha ao atualizar contrato' }, req);
    }

    return respond(res, 200, { ok: true, status: 'active', contractId }, req);

  } catch (err) {
    console.error('[confirm-contract] Erro interno:', err.message);
    return respond(res, 500, { error: 'Erro interno do servidor.' }, req);
  }
};
