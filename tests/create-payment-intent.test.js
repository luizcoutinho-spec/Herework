/**
 * Testes unitários: api/create-payment-intent.js
 * Cobre: validação, Stripe mock, metadados contract_id/user_id
 */

'use strict';

/* ─── Mock Stripe antes de importar o handler ─── */
const mockCreate = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockReturnValue({
    paymentIntents: { create: mockCreate }
  });
});

const handler = require('../api/create-payment-intent');

function mockRes() {
  const res = {
    _status: null, _body: null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(d)   { this._body = d;   return this; }
  };
  return res;
}

function makeReq(body, method = 'POST') {
  return { method, headers: { origin: 'https://herework.vercel.app' }, body };
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake123';
});

afterEach(() => mockCreate.mockClear());

describe('Método HTTP', () => {
  test('GET → 405', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res._status).toBe(405);
  });
});

describe('Validação de campos', () => {
  test('sem paymentMethodId → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ amount: 100 }), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/paymentMethodId/i);
  });

  test('sem amount → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_test' }), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/valor/i);
  });

  test('amount negativo → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_test', amount: -50 }), res);
    expect(res._status).toBe(400);
  });

  test('amount zero → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_test', amount: 0 }), res);
    expect(res._status).toBe(400);
  });
});

describe('Pagamento bem-sucedido', () => {
  test('succeeded imediato → 200 com success:true', async () => {
    mockCreate.mockResolvedValue({
      id: 'pi_test_123',
      status: 'succeeded',
      payment_method_details: { card: { last4: '4242', brand: 'visa' } },
      client_secret: null
    });
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_test', amount: 149.90 }), res);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.last4).toBe('4242');
  });

  test('passa contract_id e user_id nos metadados do Stripe', async () => {
    mockCreate.mockResolvedValue({
      id: 'pi_test_456', status: 'succeeded',
      payment_method_details: { card: { last4: '1234', brand: 'mastercard' } }
    });
    const res = mockRes();
    await handler(makeReq({
      paymentMethodId: 'pm_card',
      amount: 300,
      contractId: 'uuid-contract-abc',
      userId: 'uuid-user-xyz'
    }), res);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          contract_id: 'uuid-contract-abc',
          user_id:     'uuid-user-xyz'
        })
      })
    );
  });
});

describe('3D Secure', () => {
  test('requires_action → 200 com requiresAction:true', async () => {
    mockCreate.mockResolvedValue({
      id: 'pi_3ds', status: 'requires_action',
      client_secret: 'pi_3ds_secret_xxx'
    });
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_3ds', amount: 200 }), res);
    expect(res._status).toBe(200);
    expect(res._body.requiresAction).toBe(true);
    expect(res._body.clientSecret).toBeTruthy();
  });
});

describe('Erro de cartão (StripeCardError)', () => {
  test('cartão recusado → 402 com error', async () => {
    const cardErr = new Error('Your card was declined.');
    cardErr.type = 'StripeCardError';
    cardErr.code = 'card_declined';
    mockCreate.mockRejectedValue(cardErr);
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_declined', amount: 100 }), res);
    expect(res._status).toBe(402);
    expect(res._body.error).toMatch(/declined/i);
  });
});

describe('Erro genérico Stripe', () => {
  test('erro desconhecido → 500', async () => {
    mockCreate.mockRejectedValue(new Error('Internal Stripe error'));
    const res = mockRes();
    await handler(makeReq({ paymentMethodId: 'pm_err', amount: 50 }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
});
