/**
 * Testes unitários: api/send-email.js
 * Cobre: validação de campos, método HTTP, envio com mock
 */

'use strict';

/* Mock nodemailer */
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'ok-123' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail })
}));

const handler = require('../api/send-email');

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
  process.env.GMAIL_USER         = 'noreply@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'pass';
});

afterEach(() => mockSendMail.mockClear());

describe('Método HTTP', () => {
  test('GET → 405', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res._status).toBe(405);
  });
  test('OPTIONS → 200 (CORS preflight)', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'OPTIONS'), res);
    expect(res._status).toBe(200);
  });
});

describe('Validação de campos obrigatórios', () => {
  test('sem `to` → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ subject: 'Test', html: '<p>Oi</p>' }), res);
    expect(res._status).toBe(400);
  });

  test('sem `subject` → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ to: 'a@b.com', html: '<p>Oi</p>' }), res);
    expect(res._status).toBe(400);
  });

  test('body vazio → 400 (sem to e sem subject)', async () => {
    const res = mockRes();
    await handler(makeReq({}), res);
    expect(res._status).toBe(400);
  });
});

describe('Validação de e-mail', () => {
  test('e-mail `to` inválido → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ to: 'nao-é-email', subject: 'X', html: '<p/>' }), res);
    expect(res._status).toBe(400);
  });
});

describe('Envio bem-sucedido', () => {
  test('campos válidos → 200 com ok:true', async () => {
    const res = mockRes();
    await handler(makeReq({ to: 'user@example.com', subject: 'Bem-vindo', html: '<h1>Olá</h1>' }), res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('Resiliência', () => {
  test('SMTP falha → 500 com error', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('Connection refused'));
    const res = mockRes();
    await handler(makeReq({ to: 'u@u.com', subject: 'Test', html: '<p/>' }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
});
