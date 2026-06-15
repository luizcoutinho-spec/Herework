/**
 * Testes unitários: api/webhook.js
 * Cobre: verificação de assinatura, eventos de pagamento, sbAdmin mock
 */

'use strict';

/* ─── Mocks ─── */
const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockReturnValue({
    webhooks: { constructEvent: mockConstructEvent }
  });
});

/* Mock global fetch (Supabase admin calls) */
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  text: async () => ''
});

const handler = require('../api/webhook');

function mockRes() {
  const res = {
    _status: null, _body: null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(d)   { this._body = d;   return this; }
  };
  return res;
}

async function* fakeStream(chunks) {
  for (const c of chunks) yield c;
}

function makeReq(sig = 'sig_valid', body = 'raw', method = 'POST') {
  const req = fakeStream([Buffer.from(body)]);
  req.method = method;
  req.headers = { 'stripe-signature': sig, origin: '' };
  return req;
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY       = 'sk_test_fake';
  process.env.STRIPE_SECRET_KEY_TEST  = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET   = 'whsec_test';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test';
  process.env.SUPABASE_URL            = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-fake';
});

afterEach(() => {
  mockConstructEvent.mockClear();
  global.fetch.mockClear();
});

/* ─────────────────────────────────────
   Método HTTP
───────────────────────────────────── */
describe('Método HTTP', () => {
  test('GET → 405', async () => {
    const res = mockRes();
    const req = makeReq('sig', 'body', 'GET');
    await handler(req, res);
    expect(res._status).toBe(405);
  });
});

/* ─────────────────────────────────────
   Stripe-Signature ausente
───────────────────────────────────── */
describe('Headers obrigatórios', () => {
  test('sem Stripe-Signature → 400', async () => {
    const res = mockRes();
    const req = fakeStream([Buffer.from('body')]);
    req.method  = 'POST';
    req.headers = { origin: '' }; // sem stripe-signature
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/stripe-signature/i);
  });
});

/* ─────────────────────────────────────
   Assinatura inválida
───────────────────────────────────── */
describe('Assinatura inválida', () => {
  test('constructEvent lança erro → 400', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('Assinatura inválida'); });
    const res = mockRes();
    await handler(makeReq('bad_sig'), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/assinatura/i);
  });
});

/* ─────────────────────────────────────
   payment_intent.succeeded
───────────────────────────────────── */
describe('payment_intent.succeeded', () => {
  test('com proposal_id → cria contrato via POST /rest/v1/contracts', async () => {
    const ok = (data) => Promise.resolve({ ok: true, json: async () => data, text: async () => '' });
    global.fetch
      .mockImplementationOnce(() => ok([]))                           // A.1: idempotência → sem contrato existente
      .mockImplementationOnce(() => ok([{                             // A.2: lê proposta
          id: 'uuid-prop', project_id: 'proj-1',
          freelancer_id: 'free-1', value: 300, deadline_days: 7
      }]))
      .mockImplementationOnce(() => ok([]))                           // A.2b: regra 1:1 → sem contrato vivo
      .mockImplementationOnce(() => ok([{ title: 'Projeto Teste' }])) // A.3: título do projeto
      .mockImplementationOnce(() => ok([{ id: 'contract-new' }]));    // A.4: POST cria contrato
    // PATCHes subsequentes (proposals aceita, projects in_progress, bulk reject)
    // usam o mockResolvedValue padrão { ok: true, text: async () => '' }

    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      id: 'evt_001',
      data: { object: {
        id: 'pi_001', amount: 30000,
        metadata: { proposal_id: 'uuid-prop', client_id: 'uuid-client' }
      }}
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body.received).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/contracts'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('sem contract_id → NÃO chama Supabase', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      id: 'evt_002',
      data: { object: { id: 'pi_002', amount: 5000, metadata: { plan_id: '', user_id: '' } } }
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('com plan_id + user_id → atualiza plan no profiles', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      id: 'evt_003',
      data: { object: { id: 'pi_003', amount: 9900, metadata: { plan_id: 'pro', user_id: 'uuid-usr' } } }
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/profiles?id=eq.uuid-usr'),
      expect.objectContaining({ method: 'PATCH' })
    );
  });
});

/* ─────────────────────────────────────
   payment_intent.payment_failed
───────────────────────────────────── */
describe('payment_intent.payment_failed', () => {
  test('com contract_id → chama Supabase PATCH (disputed)', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      id: 'evt_004',
      data: { object: { id: 'pi_004', last_payment_error: { message: 'declined' }, metadata: { contract_id: 'uuid-c' } } }
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const patchCall = global.fetch.mock.calls.find(c => c[0].includes('contracts'));
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall[1].body);
    expect(body.status).toBe('disputed');
  });
});

/* ─────────────────────────────────────
   payment_intent.canceled
───────────────────────────────────── */
describe('payment_intent.canceled', () => {
  test('com contract_id → cancela contrato', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.canceled',
      id: 'evt_005',
      data: { object: { id: 'pi_005', metadata: { contract_id: 'uuid-cancel' } } }
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const patchCall = global.fetch.mock.calls.find(c => c[0].includes('uuid-cancel'));
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall[1].body);
    expect(body.status).toBe('cancelled');
  });
});

/* ─────────────────────────────────────
   Evento desconhecido
───────────────────────────────────── */
describe('Evento desconhecido', () => {
  test('evento ignorado → 200 received:true', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.created', id: 'evt_999',
      data: { object: {} }
    });
    const res = mockRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body.received).toBe(true);
  });
});
