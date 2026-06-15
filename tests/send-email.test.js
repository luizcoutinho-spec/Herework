/**
 * Testes unitários: api/send-email.js
 * Cobre: método HTTP, autenticação JWT (Supabase), validação de campos, envio via Resend
 */

'use strict';

/* Mock global.fetch: intercepta tanto auth Supabase quanto POST Resend */
global.fetch = jest.fn();

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

/* Todas as requisições POST incluem token — o código exige JWT antes de validar campos */
function makeReq(body, method = 'POST') {
  return {
    method,
    headers: {
      origin:        'https://herework.vercel.app',
      authorization: 'Bearer faketoken'
    },
    body
  };
}

beforeAll(() => {
  process.env.RESEND_API_KEY            = 'resend_fake';
  process.env.SUPABASE_URL              = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY         = 'anon-fake';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-fake';
});

beforeEach(() => {
  /* Padrão: JWT Supabase sempre válido; .json() disponível para chamadas Resend */
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  global.fetch.mockClear();
});

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

describe('Autenticação JWT', () => {
  test('sem token → 401', async () => {
    const res = mockRes();
    const req = { method: 'POST', headers: { origin: 'https://herework.vercel.app' }, body: {} };
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._body.error).toMatch(/token/i);
  });
  test('token rejeitado pelo Supabase → 401', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = mockRes();
    await handler(makeReq({ to: 'u@u.com', subject: 'X', html: '<p/>' }), res);
    expect(res._status).toBe(401);
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
    await handler(makeReq({ to: 'nao-e-email', subject: 'X', html: '<p/>' }), res);
    expect(res._status).toBe(400);
  });
});

describe('Envio bem-sucedido', () => {
  test('campos válidos → 200 com ok:true e id Resend', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })                                          // JWT Supabase
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'resend-msg-123' }) }); // Resend
    const res = mockRes();
    await handler(makeReq({ to: 'user@example.com', subject: 'Bem-vindo', html: '<h1>Olá</h1>' }), res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(res._body.id).toBe('resend-msg-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('Resiliência', () => {
  test('Resend retorna erro (ok=false) → 500 com error', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })                                                        // JWT
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Rate limit exceeded' }) }); // Resend
    const res = mockRes();
    await handler(makeReq({ to: 'u@u.com', subject: 'Test', html: '<p/>' }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
  test('Resend lança exceção de rede → 500 com error', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })                       // JWT
      .mockRejectedValueOnce(new Error('Network error'));        // Resend
    const res = mockRes();
    await handler(makeReq({ to: 'u@u.com', subject: 'Test', html: '<p/>' }), res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBeTruthy();
  });
});
