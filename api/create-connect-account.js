const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function sbGetProfile(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,stripe_account_id`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Erro ao buscar profile: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function sbSaveStripeAccountId(userId, accountId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ stripe_account_id: accountId }),
    }
  );
  if (!res.ok) { const t = await res.text(); throw new Error(`Erro ao salvar stripe_account_id: ${res.status} ${t}`); }
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  /* ── Validar JWT: user_id vem sempre do token, nunca do body ── */
  const authHeader = (req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Token de autenticação ausente.' });

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
  });
  if (!userRes.ok) return res.status(401).json({ error: 'Token inválido' });
  const user = await userRes.json();
  const callerId = user.id;

  try {
    const profile = await sbGetProfile(callerId);
    if (!profile) return res.status(404).json({ error: 'Profile não encontrado.' });
    let accountId = profile.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: profile.email || undefined,
        capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
        business_type: 'individual',
      });
      accountId = account.id;
      await sbSaveStripeAccountId(callerId, accountId);
    }
    const accountSession = await stripe.accountSessions.create({
      account: accountId,
      components: { account_onboarding: { enabled: true } },
    });
    return res.status(200).json({ account_id: accountId, client_secret: accountSession.client_secret });
  } catch (err) {
    console.error('create-connect-account error:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
