/**
 * Testes unitários: api/data-request.js
 * Cobre: validação de input, rate limiting, geração de protocolo,
 *        resposta em caso de falha de e-mail
 */

'use strict';

/* ─── Mock nodemailer antes de importar o handler ─── */
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-ok' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail })
}));

const handler = require('../api/data-request');

function mockRes() {
  const headers = {};
  const res = {
    _status: null,
    _body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(data)   { this._body = data;   return this; }
  };
  return res;
}

function makeReq(body, method = 'POST', origin = 'https://herework.vercel.app') {
  return {
    method,
    headers: { origin, 'x-forwarded-for': '1.2.3.' + Math.floor(Math.random() * 254 + 1) },
    body,
    socket: { remoteAddress: '127.0.0.1' }
  };
}

/* Env vars necessárias */
beforeAll(() => {
  process.env.GMAIL_USER         = 'test@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'fakepassword';
  process.env.DPO_EMAIL          = 'dpo@herework.com.br';
});

afterEach(() => {
  mockSendMail.mockClear();
});

/* ─────────────────────────────────────
   Método inválido
───────────────────────────────────── */
describe('Método HTTP inválido', () => {
  test('GET retorna 405', async () => {
    const res = mockRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res._status).toBe(405);
  });
});

/* ─────────────────────────────────────
   Validação de input
───────────────────────────────────── */
describe('Validação de input', () => {
  test('type ausente → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ userId: 'u1', userEmail: 'a@b.com' }), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/type/i);
  });

  test('type inválido → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ type: 'hack', userId: 'u1', userEmail: 'a@b.com' }), res);
    expect(res._status).toBe(400);
  });

  test('userId ausente → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ type: 'export', userEmail: 'a@b.com' }), res);
    expect(res._status).toBe(400);
  });

  test('userEmail ausente → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ type: 'export', userId: 'u1' }), res);
    expect(res._status).toBe(400);
  });

  test('userEmail inválido → 400', async () => {
    const res = mockRes();
    await handler(makeReq({ type: 'export', userId: 'u1', userEmail: 'nao-e-email' }), res);
    expect(res._status).toBe(400);
  });
});

/* ─────────────────────────────────────
   Tipos válidos: export, delete, rectify
───────────────────────────────────── */
describe('Tipos válidos', () => {
  const validBody = { userId: 'uuid-1234', userEmail: 'test@herework.com' };

  test.each(['export', 'delete', 'rectify'])('type=%s → 200 com protocolo', async (type) => {
    const res = mockRes();
    const ip  = '10.0.0.' + Math.floor(Math.random() * 254 + 1);
    const req = { ...makeReq({ ...validBody, type }), headers: { origin: 'https://herework.vercel.app', 'x-forwarded-for': ip } };
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(typeof res._body.protocol).toBe('string');
    expect(res._body.protocol.startsWith(type.toUpperCase())).toBe(true);
    expect(res._body.deadline).toBeTruthy();
  });
});

/* ─────────────────────────────────────
   Protocolo único
───────────────────────────────────── */
describe('Protocolo', () => {
  test('dois requests seguidos geram protocolos diferentes', async () => {
    const body = { type: 'export', userId: 'u1', userEmail: 'a@test.com' };
    const ip1 = '192.168.1.1';
    const ip2 = '192.168.1.2';
    const res1 = mockRes();
    const res2 = mockRes();
    const req1 = { method: 'POST', headers: { origin: 'https://herework.vercel.app', 'x-forwarded-for': ip1 }, body, socket: {} };
    const req2 = { method: 'POST', headers: { origin: 'https://herework.vercel.app', 'x-forwarded-for': ip2 }, body, socket: {} };
    await handler(req1, res1);
    await handler(req2, res2);
    // Ambos devem ter sucesso e protocolos distintos
    expect(res1._status).toBe(200);
    expect(res2._status).toBe(200);
    expect(res1._body.protocol).not.toBe(res2._body.protocol);
  });
});

/* ─────────────────────────────────────
   Falha de e-mail não derruba o endpoint
───────────────────────────────────── */
describe('Resiliência a falha de e-mail', () => {
  test('sendMail rejeita → ainda retorna 200 com protocolo', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
    const res = mockRes();
    const ip  = '172.16.0.1';
    const req = { method: 'POST', headers: { origin: 'https://herework.vercel.app', 'x-forwarded-for': ip }, body: { type: 'delete', userId: 'u1', userEmail: 'x@x.com' }, socket: {} };
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(typeof res._body.protocol).toBe('string');
  });
});

/* ─────────────────────────────────────
   Envio de e-mails (DPO + usuário)
───────────────────────────────────── */
describe('Envio de e-mails', () => {
  test('envia 2 e-mails: DPO e titular', async () => {
    const ip  = '203.0.113.1';
    const req = { method: 'POST', headers: { origin: 'https://herework.vercel.app', 'x-forwarded-for': ip }, body: { type: 'rectify', userId: 'u2', userEmail: 'user@test.com' }, socket: {} };
    const res = mockRes();
    await handler(req, res);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    const calls = mockSendMail.mock.calls;
    const toAddresses = calls.map(c => c[0].to);
    expect(toAddresses).toContain('dpo@herework.com.br');
    expect(toAddresses).toContain('user@test.com');
  });
});
