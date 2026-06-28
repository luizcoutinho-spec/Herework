// supabase/functions/vitae-ai-import/index.ts
// Vitae — importação de currículo via IA (Etapa C.2)
//
// SEGURANÇA:
//   • ANTHROPIC_API_KEY: somente Deno.env.get(), nunca hardcoded, nunca logada.
//   • Conteúdo do CV: nunca logado (LGPD — dados pessoais sensíveis).
//   • Logs contêm apenas uid e status HTTP.
//
// ORDEM DE OPERAÇÕES:
//   OPTIONS → método → JWT → body → LIMITE (429 sem chamar IA) → IA → resposta
//   Falha da IA → decrement (devolve crédito) → 502

// ── CORS (molde idêntico a hw-create-payment-intent) ───────────────────────
const ALLOWED_ORIGINS = [
  "https://www.herework.com.br",
  "https://herework.com.br",
  "https://herework.vercel.app",
];
const _envOrigin = Deno.env.get("ALLOWED_ORIGIN");
if (_envOrigin && !ALLOWED_ORIGINS.includes(_envOrigin))
  ALLOWED_ORIGINS.push(_envOrigin);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(
  body:   unknown,
  status: number                  = 200,
  cors:   Record<string, string>  = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── Env vars ────────────────────────────────────────────────────────────────
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// ── JWT gate (molde idêntico a hw-create-payment-intent) ────────────────────
async function getUid(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
  });
  if (!r.ok) return null;
  return (await r.json())?.id ?? null;
}

// ── Controle de uso diário (RPC atômico do C.1) ─────────────────────────────
async function incrementUsage(uid: string, limit: number): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_ai_usage`, {
    method: "POST",
    headers: {
      apikey:         SERVICE_ROLE,
      Authorization:  `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_user: uid, p_limit: limit }),
  });
  if (!r.ok) {
    // RPC falhou → negar por segurança (fail-closed: não chama IA sem confirmar limite)
    console.error("[vitae-ai-import] increment_ai_usage RPC error:", r.status, "uid:", uid);
    return false;
  }
  return (await r.json()) === true;
}

async function decrementUsage(uid: string): Promise<void> {
  // Best-effort: devolve crédito se a IA falhou após o incremento.
  // Nunca lança exceção para não mascarar o erro principal.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/decrement_ai_usage`, {
      method: "POST",
      headers: {
        apikey:         SERVICE_ROLE,
        Authorization:  `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user: uid }),
    });
  } catch {
    console.error("[vitae-ai-import] decrement_ai_usage failed, uid:", uid);
  }
}

// ── Instrução e schema (movidos do front para o backend) ────────────────────
// A instrução e o IMPORT_TOOL nunca chegam ao navegador: ficam aqui,
// no runtime Deno, junto com a chave.

const INSTRUCAO =
  "Você é especialista em currículos. Extraia TODAS as informações do " +
  "currículo a seguir e devolva pela ferramenta. Escreva no mesmo idioma " +
  "do currículo original. NUNCA invente dados; deixe vazio o que não " +
  "constar. Reescreva descrições com impacto sem alterar fatos.";

const IMPORT_TOOL = {
  name:        "curriculo",
  description: "Dados estruturados do currículo.",
  input_schema: {
    type:                 "object",
    additionalProperties: false,
    properties: {
      nome:        { type: "string" },
      headline:    { type: "string" },
      localizacao: { type: "string" },
      telefone:    { type: "string" },
      email:       { type: "string" },
      linkedin:    { type: "string" },
      website:     { type: "string" },
      resumo:      { type: "string" },
      experiencias: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            cargo:     { type: "string" },
            empresa:   { type: "string" },
            periodo:   { type: "string" },
            local:     { type: "string" },
            descricao: { type: "string" },
          },
          required: ["cargo", "empresa", "periodo", "local", "descricao"],
        },
      },
      educacao: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            curso:       { type: "string" },
            instituicao: { type: "string" },
            periodo:     { type: "string" },
          },
          required: ["curso", "instituicao", "periodo"],
        },
      },
      conquistas: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            titulo:    { type: "string" },
            descricao: { type: "string" },
          },
          required: ["titulo", "descricao"],
        },
      },
      competencias: { type: "array", items: { type: "string" } },
      idiomas: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            idioma: { type: "string" },
            nivel:  { type: "string" },
          },
          required: ["idioma", "nivel"],
        },
      },
      premios: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            titulo:    { type: "string" },
            descricao: { type: "string" },
          },
          required: ["titulo", "descricao"],
        },
      },
    },
    required: [
      "nome", "headline", "localizacao", "telefone", "email",
      "linkedin", "website", "resumo", "experiencias", "educacao",
      "conquistas", "competencias", "idiomas", "premios",
    ],
  },
};

// ── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const CORS = corsHeaders(req);

  // 1a. CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 1b. Método
  if (req.method !== "POST")
    return json({ error: "Method not allowed" }, 405, CORS);

  // 2. JWT gate — apenas usuários autenticados passam daqui
  const uid = await getUid(req.headers.get("authorization"));
  if (!uid) return json({ error: "Não autenticado." }, 401, CORS);

  // 3. Body — content blocks extraídos no front (pdf.js / mammoth)
  //    Não logamos o conteúdo: são dados pessoais do CV.
  let body: { content?: unknown };
  try   { body = await req.json(); }
  catch { return json({ error: "JSON inválido." }, 400, CORS); }

  const content = body?.content;
  if (!Array.isArray(content) || content.length === 0)
    return json({ error: "content obrigatório e não-vazio." }, 400, CORS);

  // 4. LIMITE — incremento atômico ANTES de chamar a IA.
  //    Se false → limite atingido → 429 sem tocar na Anthropic.
  const allowed = await incrementUsage(uid, 3);
  if (!allowed) {
    return json(
      { error: "Limite diário de importações atingido.", code: "AI_LIMIT" },
      429, CORS,
    );
  }

  // 5. Chamada à Anthropic.
  //    Em TODOS os caminhos de falha abaixo → decrement (devolve crédito).
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":          ANTHROPIC_KEY, // env var — nunca logada
        "anthropic-version":  "2023-06-01",
        "content-type":       "application/json",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{
          role:    "user",
          content: [...(content as unknown[]), { type: "text", text: INSTRUCAO }],
        }],
        tools:       [IMPORT_TOOL],
        tool_choice: { type: "tool", name: "curriculo" },
      }),
      signal: AbortSignal.timeout(55_000), // 55 s — margem antes do limite da Edge (60 s)
    });

    // 5f-i. Erro HTTP da Anthropic
    if (!aiRes.ok) {
      console.error("[vitae-ai-import] Anthropic HTTP", aiRes.status, "uid:", uid);
      await decrementUsage(uid);
      return json({ error: "Falha na IA.", code: "AI_ERROR" }, 502, CORS);
    }

    const data = await aiRes.json();
    const blk  = (data.content ?? []).find(
      (b: { type: string }) => b.type === "tool_use",
    ) as { input: unknown } | undefined;

    // 5f-ii. IA retornou 200 mas sem bloco tool_use
    if (!blk) {
      console.error("[vitae-ai-import] sem tool_use, uid:", uid);
      await decrementUsage(uid);
      return json({ error: "IA não estruturou o currículo.", code: "AI_NO_RESULT" }, 502, CORS);
    }

    // 5f-iii. Sucesso — retorna apenas os dados estruturados
    console.log("[vitae-ai-import] ok, uid:", uid);
    return json({ data: blk.input }, 200, CORS);

  } catch (err) {
    // Timeout (AbortError / TimeoutError) ou erro de rede
    const label = (err as Error)?.name === "TimeoutError" ? "timeout" : "exception";
    console.error("[vitae-ai-import]", label, "uid:", uid);
    await decrementUsage(uid);
    return json({ error: "Falha na IA.", code: "AI_ERROR" }, 502, CORS);
  }
});
