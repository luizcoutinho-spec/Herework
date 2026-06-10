/**
 * Testes unitários: api/_helpers.js
 * Cobre: respond(), handleCors(), toCents(), CORS headers
 */

'use strict';

const { respond, handleCors, toCents } = require('../api/_helpers');

/* ─── Mock do objeto res (Vercel/Express-like) ─── */
function mockRes() {
  const headers = {};
  const res = {
    _status: null,
    _body:   null,
    headers,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(data)   { this._body = data; return this; }
  };
  return res;
}

function mockReq(origin = '', method = 'POST') {
  return { method, headers: { origin } };
}

/* ─────────────────────────────────────
   toCents
───────────────────────────────────── */
describe('toCents()', () => {
  test('converte valor inteiro', () => {
    expect(toCents(100)).toBe(10000);
  });
  test('converte valor decimal com 2 casas', () => {
    expect(toCents(149.90)).toBe(14990);
  });
  test('arredonda floating-point ambiguidade', () => {
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30 → 30 cents
  });
  test('aceita string numérica', () => {
    expect(toCents('50.00')).toBe(5000);
  });
});

/* ─────────────────────────────────────
   respond() — status e body
───────────────────────────────────── */
describe('respond() — status e body', () => {
  test('define status correto', () => {
    const res = mockRes();
    respond(res, 200, { ok: true }, mockReq());
    expect(res._status).toBe(200);
  });
  test('define body correto', () => {
    const res = mockRes();
    respond(res, 404, { error: 'não encontrado' }, mockReq());
    expect(res._body).toEqual({ error: 'não encontrado' });
  });
  test('define Content-Type: application/json', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq());
    expect(res.headers['Content-Type']).toBe('application/json');
  });
  test('define X-Content-Type-Options: nosniff', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq());
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });
});

/* ─────────────────────────────────────
   respond() — CORS
───────────────────────────────────── */
describe('respond() — CORS', () => {
  test('origem permitida — reflete a origem', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq('https://herework.vercel.app'));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://herework.vercel.app');
    expect(res.headers['Vary']).toBe('Origin');
  });
  test('localhost:3000 permitido', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq('http://localhost:3000'));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
  });
  test('localhost:5173 permitido', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq('http://localhost:5173'));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });
  test('127.0.0.1:5500 permitido', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq('http://127.0.0.1:5500'));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:5500');
  });
  test('origem desconhecida — NÃO emite header ACAO', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq('https://malicious.example.com'));
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
  test('sem origem (server-to-server) — usa herework.vercel.app', () => {
    const res = mockRes();
    respond(res, 200, {}, mockReq(''));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://herework.vercel.app');
  });
  test('req ausente — não lança erro', () => {
    const res = mockRes();
    expect(() => respond(res, 200, {}, null)).not.toThrow();
  });
});

/* ─────────────────────────────────────
   handleCors()
───────────────────────────────────── */
describe('handleCors()', () => {
  test('OPTIONS → responde 200 e retorna true', () => {
    const res = mockRes();
    const req = mockReq('https://herework.vercel.app', 'OPTIONS');
    const handled = handleCors(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
  });
  test('POST → não intercepta, retorna false', () => {
    const res = mockRes();
    const req = mockReq('https://herework.vercel.app', 'POST');
    const handled = handleCors(req, res);
    expect(handled).toBe(false);
    expect(res._status).toBeNull();
  });
});
