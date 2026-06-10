/**
 * Testes unitários: api/pix.js
 * Cobre: validação, Stripe mock (create + confirm), PIX QR, erros
 */

'use strict';

/* Mock Stripe */
const mockCreate  = jest.fn();
const mockConfirm = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockReturnValue({
    paymentIntents: { create: mockCreate, confirm: mockConfirm }
  });
});

const handler = require('../api/pix');

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
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
});

afterEach(() => {
  mockCreate.mockClear();
  mockConfirm.mockClear();
});

describe('Método HTTP', () => {
  test('GET → 405', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res._status).toBe(405);
  });
});

describe('Validação de amount', () => {
  test('sem amount → 400', async () => {
    const res = mockRes();
    await handler(makeReq({}), res);
    expect(res._status).toBe(400);
  });

  test('amount NaN → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ amount: 'abc' }), res);
    expect(res._status).toBe(400);
  });

  test('amount = 0 → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ amount: 0 }), res);
    expect(res._status).toBe(400);
  });
});

describe('PIX criado com sucesso', () => {
  test('retorna paymentIntentId, pixQrCode e status', async () => {
    mockCreate.mockResolvedValue({ id: 'pi_pix_001', client_secret: 'sec_xxx' });
    mockConfirm.mockResolvedValue({
      id: 'pi_pix_001',
      client_secret: 'sec_xxx',
      status: 'requires_action',
      next_action: {
        pix_display_qr_code: {
          data: 'pix_qr_code_string',
          image_url_png: 'https://stripe.com/qr.png',
          hosted_instructions_url: 'https://stripe.com/pix'
        }
      }
    });
    const res = mockRes();
    await handler(makeReq({ amount: 250 }), res);
    expect(res._status).toBe(200);
    expect(res._body.paymentIntentId).toBe('pi_pix_001');
    expect(res._body.pixQrCode).toBe('pix_qr_code_string');
    expect(res._body.expiresAt).toBeGreaterThan(0);
  });
});

describe('PIX não ativado', () => {
  test('payment_method_unactivated → 402 com instrução', async () => {
    const err = new Error('PIX is not activated');
    err.code = 'payment_method_unactivated';
    mockCreate.mockRejectedValue(err);
    const res = mockRes();
    await handler(makeReq({ amount: 100 }), res);
    expect(res._status).toBe(402);
    expect(res._body.error).toMatch(/pix/i);
  });
});

describe('Erro genérico', () => {
  test('erro desconhecido → 500', async () => {
    mockCreate.mockRejectedValue(new Error('Unexpected error'));
    const res = mockRes();
    await handler(makeReq({ amount: 100 }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
});
