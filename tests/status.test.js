/**
 * Testes unitários: api/status.js
 * Cobre: validação do ID, consulta Stripe, resposta
 */

'use strict';

/* Mock Stripe */
const mockRetrieve = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockReturnValue({
    paymentIntents: { retrieve: mockRetrieve }
  });
});

const handler = require('../api/status');

function mockRes() {
  const res = {
    _status: null, _body: null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(d)   { this._body = d;   return this; }
  };
  return res;
}

function makeReq(query = {}, method = 'GET') {
  return { method, headers: { origin: '' }, query };
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY      = 'sk_test_fake';
  process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_fake';
});

afterEach(() => mockRetrieve.mockClear());

describe('Método HTTP', () => {
  test('POST → 405', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'POST'), res);
    expect(res._status).toBe(405);
  });
});

describe('Validação do ID', () => {
  test('id ausente → 400', async () => {
    const res = mockRes();
    await handler(makeReq({}), res);
    expect(res._status).toBe(400);
  });

  test('id não começa com pi_ → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ id: 'pm_not_a_pi' }), res);
    expect(res._status).toBe(400);
  });
});

describe('Consulta Stripe bem-sucedida', () => {
  test('succeeded → 200 com succeeded:true', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'pi_123', status: 'succeeded',
      amount: 15000, currency: 'brl', metadata: {}
    });
    const res = mockRes();
    await handler(makeReq({ id: 'pi_123' }), res);
    expect(res._status).toBe(200);
    expect(res._body.succeeded).toBe(true);
    expect(res._body.amount).toBe(150); // 15000 cents → R$ 150
    expect(res._body.currency).toBe('brl');
  });

  test('processing → 200 com succeeded:false', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'pi_456', status: 'processing',
      amount: 5000, currency: 'brl', metadata: {}
    });
    const res = mockRes();
    await handler(makeReq({ id: 'pi_456' }), res);
    expect(res._status).toBe(200);
    expect(res._body.succeeded).toBe(false);
    expect(res._body.status).toBe('processing');
  });
});

describe('Erro do Stripe', () => {
  test('retrieve falha → 500', async () => {
    mockRetrieve.mockRejectedValue(new Error('Stripe API error'));
    const res = mockRes();
    await handler(makeReq({ id: 'pi_err' }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
});
