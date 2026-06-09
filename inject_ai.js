var fs = require('fs');
var html = fs.readFileSync('app.html', 'utf8');

var newScript = `
<script>
/* ═══════════════════════════════════════════════════════════════════
   HEREWORK — Análise de Propostas por IA  (v1.0)
   ═══════════════════════════════════════════════════════════════════ */

/* ── Configuração da API de IA ───────────────────────────────────── */
/* Compatível com qualquer endpoint OpenAI-compatible (GPT-4o, etc.) */
var _HW_AI_CONFIG = {
  apiKey:   '',   /* ← Cole aqui: sk-...  (OpenAI) ou chave compatível */
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model:    'gpt-4o-mini',
  maxTokens: 2800
};

/* ── Cache de análises por projeto (persiste no localStorage) ──── */
var _hwAiCache = {};
(function(){
  try { _hwAiCache = JSON.parse(localStorage.getItem('hw_ai_cache') || '{}'); }
  catch(x) {}
})();
function _hwPersistCache() {
  try { localStorage.setItem('hw_ai_cache', JSON.stringify(_hwAiCache)); } catch(x) {}
}

/* ═══════════════════════════════════════════════════════════════════
   PDF — extração de texto via fetch + parse de bytes raw
   ═══════════════════════════════════════════════════════════════════ */
async function _hwExtractPdfText(url) {
  if (!url) return '';
  try {
    var resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
    if (!resp.ok) return '';
    var buf = await resp.arrayBuffer();
    var u8  = new Uint8Array(buf);
    var raw = '';
    for (var i = 0; i < Math.min(u8.length, 300000); i++) {
      var b = u8[i];
      raw += (b >= 32 && b < 127) ? String.fromCharCode(b)
           : (b === 10 || b === 13) ? ' ' : '';
    }
    /* Extrai texto entre parênteses seguido de Tj/TJ (PDF text streams) */
    var parts = [];
    var reT   = /\(([^)(]{2,300})\)\s*T[jJ]/g;
    var m;
    while ((m = reT.exec(raw)) !== null) {
      var t = m[1].replace(/\\n/g,' ').replace(/\\r/g,' ').replace(/\\t/g,' ')
                  .replace(/\\\d{3}/g,'').replace(/\\/g,'').trim();
      if (t.length > 3 && /[a-zA-ZÀ-ú0-9]/.test(t)) parts.push(t);
    }
    /* Fallback: strings longas entre parênteses */
    if (parts.length < 5) {
      var reF = /\(([^)(]{10,400})\)/g;
      while ((m = reF.exec(raw)) !== null) {
        var t2 = m[1].replace(/\\\d{3}/g,'').replace(/\\/g,'').trim();
        if (/[a-zA-ZÀ-ú]{4,}/.test(t2)) parts.push(t2);
      }
    }
    return parts.slice(0, 120).join(' ').substring(0, 3000);
  } catch(e) { return ''; }
}
window._hwExtractPdfText = _hwExtractPdfText;

/* ═══════════════════════════════════════════════════════════════════
   PROMPT BUILDER
   ═══════════════════════════════════════════════════════════════════ */
function _hwBuildAiPrompt(proposals, ctx, pdfTexts) {
  var single    = proposals.length === 1;
  var projTitle = ctx.projTitle    || 'Projeto';
  var bMin      = ctx.budgetMin    || 0;
  var bMax      = ctx.budgetMax    || 0;
  var refDays   = ctx.deadlineDays || 30;

  var propsBlock = proposals.map(function(p, i) {
    var fl  = p.freelancer || {};
    var pdf = pdfTexts[i]
      ? '\n   [CONTEÚDO DO ANEXO PDF]:\n   ' + pdfTexts[i].substring(0, 1800) + '\n   [FIM DO ANEXO]'
      : '';
    return [
      '--- PROPOSTA ' + (i + 1) + ' ---',
      'Freelancer: '          + (fl.name          || 'Desconhecido'),
      'Avaliação: '           + (fl.rating         || 'N/D') + '/5.0',
      'Projetos concluídos: ' + (fl.completed_jobs || 0),
      'Valor proposto: R$ '   + parseFloat(p.value || 0).toFixed(2),
      'Prazo proposto: '      + (p.deadline_days   || 0) + ' dias',
      'Carta de apresentação:\n   ' + (p.cover_letter || 'Não informada'),
      'Arquivos anexados: '   + ((p.attachments || []).length) + ' arquivo(s)',
      pdf
    ].join('\n');
  }).join('\n\n');

  var schemaOut = single
    ? '{"resumo_executivo":"2-3 frases","freelancer":"nome","pontos_fortes":["p1","p2","p3"],"pontos_fracos":["p1","p2"],"score":0,"nivel_aderencia":0,"riscos":["r1"],"oportunidades":["o1"],"recomendacao":"frase curta","justificativa":"2-3 parágrafos","veredicto":"CONTRATAR|NEGOCIAR|RECUSAR"}'
    : '{"resumo_executivo":"frase","propostas":[{"freelancer":"nome","pontos_fortes":["p1"],"pontos_fracos":["p1"],"score":0,"risco_principal":"texto"}],"ranking":["nome1","nome2"],"melhor_custo_beneficio":"nome","melhor_qualificacao":"nome","riscos_gerais":["r1"],"recomendacao":"nome do recomendado","justificativa":"2-3 parágrafos"}';

  return [
    'Você é um especialista sênior em análise e contratação de freelancers.',
    'Analise as propostas para o projeto e forneça insights objetivos para apoiar a decisão do cliente.',
    '',
    'PROJETO: "' + projTitle + '"',
    'Orçamento: R$ ' + bMin + (bMax > 0 ? ' – R$ ' + bMax : '+'),
    'Prazo esperado: ' + refDays + ' dias',
    '',
    'PROPOSTAS:',
    propsBlock,
    '',
    single
      ? 'Analise esta proposta: qualidade, aderência, riscos e se vale contratar.'
      : 'Compare as propostas. Aponte a melhor, custo-benefício, qualificação e faça recomendação clara.',
    '',
    'Retorne SOMENTE este JSON (sem markdown, sem texto fora do JSON):',
    schemaOut
  ].join('\n');
}

/* ═══════════════════════════════════════════════════════════════════
   CHAMADA DA API DE IA
   ═══════════════════════════════════════════════════════════════════ */
async function _hwCallAiApi(prompt) {
  var cfg  = _HW_AI_CONFIG;
  var resp = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify({
      model:       cfg.model,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  cfg.maxTokens,
      temperature: 0.25
    })
  });
  if (!resp.ok) {
    var e = '';
    try { e = JSON.stringify(await resp.json()); } catch(x) {}
    throw new Error('API ' + resp.status + ': ' + e);
  }
  var data = await resp.json();
  var txt  = ((data.choices || [{}])[0].message || {}).content || '{}';
  txt = txt.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  return JSON.parse(txt);
}

/* ═══════════════════════════════════════════════════════════════════
   MODO SIMULAÇÃO (sem API key — usa algoritmo local)
   ═══════════════════════════════════════════════════════════════════ */
function _hwSimulateReport(proposals, ctx) {
  var single = proposals.length === 1;
  var scored = proposals.map(function(p) { return _calcProposalScore(p, ctx); });
  scored.sort(function(a, b) { return b.total - a.total; });

  function _fortes(s, p) {
    return [
      s.priceScore >= 70      ? 'Valor proposto alinhado ao orçamento do projeto'  : null,
      s.deadlineScore >= 70   ? 'Prazo de entrega competitivo e realista'          : null,
      s.qualityScore >= 70    ? 'Perfil bem avaliado com experiência comprovada'   : null,
      s.commercialScore >= 70 ? 'Histórico consistente de entregas na plataforma' : null,
      (p.cover_letter||'').length >= 300 ? 'Carta de apresentação detalhada e técnica' : null
    ].filter(Boolean).slice(0, 4);
  }
  function _fracos(s, p) {
    return [
      s.priceScore < 50        ? 'Valor acima do orçamento máximo definido'         : null,
      s.deadlineScore < 50     ? 'Prazo de entrega supera o esperado para o projeto' : null,
      s.qualityScore < 50      ? 'Histórico reduzido de avaliações na plataforma'   : null,
      (p.cover_letter||'').length < 120 ? 'Carta de apresentação superficial'       : null
    ].filter(Boolean).slice(0, 3);
  }

  if (single) {
    var s  = scored[0];
    var p0 = proposals[0];
    var fl = p0.freelancer || {};
    var sc = s.total;
    var adh = Math.min(100, Math.max(0, sc + (sc > 60 ? 5 : -5)));
    var verd = sc >= 72 ? 'CONTRATAR' : sc >= 48 ? 'NEGOCIAR' : 'RECUSAR';
    var vRec = {
      CONTRATAR: 'Recomendamos contratar ' + (fl.name||'este freelancer') + '.',
      NEGOCIAR:  'Recomendamos negociar os termos antes de contratar ' + (fl.name||'este freelancer') + '.',
      RECUSAR:   'Recomendamos avaliar outras alternativas antes de contratar ' + (fl.name||'este freelancer') + '.'
    };
    var vJust = {
      CONTRATAR: (fl.name||'O freelancer') + ' apresenta uma proposta sólida, com ' + s.justification + '. A relação preço-prazo-qualidade é favorável para o projeto "' + ctx.projTitle + '". A análise não identificou riscos críticos que justifiquem reconsiderar a contratação.',
      NEGOCIAR:  'A proposta de ' + (fl.name||'este profissional') + ' tem méritos — ' + s.justification + ' — mas apresenta ' + (s.risk||'pontos que merecem alinhamento') + '. Uma conversa de escopo pode tornar esta uma excelente contratação.',
      RECUSAR:   'A proposta apresenta ' + (s.risk||'limitações relevantes') + ' em relação aos requisitos do projeto. Recomendamos aguardar novas propostas ou renegociar o escopo antes de prosseguir.'
    };
    return {
      _simulated: true,
      resumo_executivo: 'A proposta de ' + (fl.name||'Freelancer') + ' para "' + ctx.projTitle + '" foi analisada com base em preço, prazo, qualificação técnica e condições comerciais. Score geral: ' + sc + '/100.',
      freelancer: fl.name || 'Freelancer',
      pontos_fortes: _fortes(s, p0),
      pontos_fracos: _fracos(s, p0),
      score: sc,
      nivel_aderencia: adh,
      riscos: [
        parseFloat(p0.value||0) > ctx.budgetMax && ctx.budgetMax > 0
          ? 'Valor supera o orçamento máximo em R$ ' + (parseFloat(p0.value||0) - ctx.budgetMax).toFixed(0) : null,
        (fl.rating||5) < 4 && fl.rating > 0
          ? 'Avaliação abaixo da média da plataforma (' + fl.rating + '/5)' : null,
        (p0.cover_letter||'').length < 80
          ? 'Proposta com pouco detalhamento — risco de divergência de escopo' : null
      ].filter(Boolean),
      oportunidades: [
        s.deadlineScore >= 80        ? 'Entrega ágil pode antecipar o lançamento do produto' : null,
        (fl.completed_jobs||0) >= 10 ? 'Freelancer experiente reduz ciclos de revisão'       : null,
        s.priceScore >= 85           ? 'Preço abaixo do orçamento — margem para extras'      : null
      ].filter(Boolean),
      recomendacao: vRec[verd],
      justificativa: vJust[verd],
      veredicto: verd
    };
  } else {
    var allProps = proposals.map(function(p, i) {
      var s  = scored.find(function(x){ return x.flName === (p.freelancer||{}).name; }) || scored[i] || {};
      var fl = p.freelancer || {};
      return {
        freelancer: fl.name || ('Freelancer ' + (i + 1)),
        pontos_fortes: _fortes(s, p),
        pontos_fracos: _fracos(s, p),
        score: s.total || 50,
        risco_principal: s.risk || 'Sem riscos críticos identificados'
      };
    });
    var top = scored[0];
    var bCB = scored.reduce(function(a,b){ return a.priceScore   > b.priceScore   ? a : b; });
    var bQL = scored.reduce(function(a,b){ return a.qualityScore > b.qualityScore ? a : b; });
    return {
      _simulated: true,
      resumo_executivo: 'Foram analisadas ' + proposals.length + ' propostas para "' + ctx.projTitle + '". ' + top.flName + ' se destaca com score ' + top.total + '/100 e melhor equilíbrio geral entre os critérios avaliados.',
      propostas: allProps,
      ranking:   scored.map(function(s){ return s.flName; }),
      melhor_custo_beneficio: bCB.flName,
      melhor_qualificacao:    bQL.flName,
      riscos_gerais: [
        proposals.some(function(p){ return parseFloat(p.value||0) > ctx.budgetMax && ctx.budgetMax > 0; })
          ? 'Uma ou mais propostas excedem o orçamento máximo definido' : null,
        proposals.some(function(p){ return (p.freelancer||{}).rating < 4 && (p.freelancer||{}).rating > 0; })
          ? 'Alguns freelancers têm avaliação abaixo da média da plataforma' : null,
        proposals.some(function(p){ return (p.cover_letter||'').length < 80; })
          ? 'Algumas propostas têm cartas de apresentação superficiais' : null
      ].filter(Boolean),
      recomendacao: top.flName,
      justificativa: top.flName + ' obteve score ' + top.total + '/100, destacando-se em ' + top.justification + '. A proposta apresenta o melhor equilíbrio para o projeto "' + ctx.projTitle + '".' + (top.risk ? ' Ponto de atenção: ' + top.risk + '.' : '') + ' Recomendamos iniciar a contratação com um alinhamento de escopo antes da formalização do contrato.'
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ORQUESTRADOR PRINCIPAL
   ═══════════════════════════════════════════════════════════════════ */
async function _hwAnalyzeProposals(forceReanalyze) {
  var ctx = window._pmodCtx;
  var el  = document.getElementById('pmod-ai-panel');
  if (!el || !ctx || !(ctx.proposals || []).length) return;
  var pid = ctx.projectId;

  /* Cache hit */
  if (!forceReanalyze && _hwAiCache[pid]) {
    _hwRenderReport(_hwAiCache[pid], ctx);
    return;
  }

  /* Loading */
  el.innerHTML = [
    '<div style="text-align:center;padding:52px 24px 40px;">',
      '<div style="font-size:48px;margin-bottom:16px;display:inline-block;animation:spin 2.5s linear infinite;">🤖</div>',
      '<div style="font-size:16px;font-weight:800;color:var(--text);margin-bottom:6px;">Analisando ' + ctx.proposals.length + ' proposta' + (ctx.proposals.length !== 1 ? 's' : '') + '…</div>',
      '<div id="hw-ai-prog-txt" style="font-size:13px;color:var(--text-3);margin-bottom:18px;">Iniciando…</div>',
      '<div style="max-width:360px;margin:0 auto;background:var(--border,#e5e7eb);border-radius:6px;height:8px;overflow:hidden;">',
        '<div id="hw-ai-prog-bar" style="height:100%;width:4%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:6px;transition:width .6s ease;"></div>',
      '</div>',
    '</div>'
  ].join('');

  function _prog(msg, pct) {
    var t = document.getElementById('hw-ai-prog-txt');
    var b = document.getElementById('hw-ai-prog-bar');
    if (t) t.textContent = msg;
    if (b) b.style.width = pct + '%';
  }

  try {
    _prog('Coletando dados das propostas…', 12);
    await new Promise(function(r){ setTimeout(r, 200); });

    /* Extração de texto dos PDFs */
    var pdfTexts  = new Array(ctx.proposals.length).fill('');
    var totalPdfs = ctx.proposals.reduce(function(s, p) {
      return s + (p.attachments || []).filter(function(f){ return /\.pdf$/i.test(f.url || f); }).length;
    }, 0);
    var pdfDone = 0;
    for (var i = 0; i < ctx.proposals.length; i++) {
      var files = ctx.proposals[i].attachments || [];
      var texts = [];
      for (var j = 0; j < files.length; j++) {
        var fu = files[j].url || files[j];
        if (/\.pdf$/i.test(fu)) {
          pdfDone++;
          _prog('Lendo PDF ' + pdfDone + ' de ' + totalPdfs + '…', 12 + Math.round(pdfDone / Math.max(totalPdfs, 1) * 38));
          try { var xt = await _hwExtractPdfText(fu); if (xt) texts.push(xt); } catch(xe) {}
        }
      }
      pdfTexts[i] = texts.join('\n\n');
    }

    _prog('Processando análise inteligente…', 55);
    await new Promise(function(r){ setTimeout(r, 280); });

    var report;
    if (_HW_AI_CONFIG.apiKey) {
      _prog('Consultando IA (pode levar alguns segundos)…', 63);
      try {
        var prompt = _hwBuildAiPrompt(ctx.proposals, ctx, pdfTexts);
        report = await _hwCallAiApi(prompt);
        report._aiPowered = true;
      } catch(apiErr) {
        console.warn('[HW-AI] API falhou, usando simulação:', apiErr.message);
        report = _hwSimulateReport(ctx.proposals, ctx);
        report._apiError = apiErr.message.substring(0, 150);
      }
    } else {
      report = _hwSimulateReport(ctx.proposals, ctx);
    }

    _prog('Formatando relatório…', 92);
    await new Promise(function(r){ setTimeout(r, 250); });

    /* Metadados */
    report._projectId   = pid;
    report._projTitle   = ctx.projTitle;
    report._analyzedAt  = new Date().toISOString();
    report._proposalCnt = ctx.proposals.length;
    report._pdfCount    = totalPdfs;

    /* Persistir */
    _hwAiCache[pid] = report;
    _hwPersistCache();

    _prog('Pronto!', 100);
    await new Promise(function(r){ setTimeout(r, 300); });
    _hwRenderReport(report, ctx);

  } catch(err) {
    el.innerHTML = [
      '<div style="text-align:center;padding:48px 24px;">',
        '<div style="font-size:38px;margin-bottom:12px;">⚠️</div>',
        '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;">Erro na análise</div>',
        '<div style="font-size:13px;color:var(--text-3);margin-bottom:20px;">' + _sanitize(err.message || 'Erro desconhecido') + '</div>',
        '<button class="btn btn-outline btn-sm" onclick="_hwAnalyzeProposals(true)">🔄 Tentar novamente</button>',
      '</div>'
    ].join('');
  }
}
window._hwAnalyzeProposals = _hwAnalyzeProposals;

/* ═══════════════════════════════════════════════════════════════════
   RENDERIZAÇÃO DO RELATÓRIO
   ═══════════════════════════════════════════════════════════════════ */
function _hwRenderReport(report, ctx) {
  var el = document.getElementById('pmod-ai-panel');
  if (!el) return;
  var single   = !report.propostas;
  var ts       = report._analyzedAt ? new Date(report._analyzedAt).toLocaleString('pt-BR') : '';
  var pdfBadge = report._pdfCount > 0
    ? '<span style="font-size:10px;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:20px;font-weight:700;margin-left:6px;">📄 ' + report._pdfCount + ' PDF' + (report._pdfCount > 1 ? 's' : '') + '</span>' : '';
  var srcBadge = report._aiPowered
    ? '<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:20px;font-weight:700;margin-left:6px;">✨ IA REAL</span>'
    : '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:20px;font-weight:700;margin-left:6px;">⚙️ SIMULADO</span>';
  var h = [];

  h.push(
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;gap:10px;flex-wrap:wrap;">',
      '<div>',
        '<div style="font-size:16px;font-weight:800;color:var(--text);">🤖 Análise de Propostas por IA' + srcBadge + pdfBadge + '</div>',
        ts ? '<div style="font-size:11px;color:var(--text-4);margin-top:3px;">Analisado em ' + _sanitize(ts) + ' &nbsp;·&nbsp; ' + (report._proposalCnt || 1) + ' proposta' + ((report._proposalCnt || 1) !== 1 ? 's' : '') + '</div>' : '',
      '</div>',
      '<div style="display:flex;gap:6px;flex-shrink:0;">',
        '<button class="btn btn-outline btn-sm" style="font-size:11px;" onclick="_hwAnalyzeProposals(true)">🔄 Reanalisar</button>',
        '<button class="btn btn-outline btn-sm" style="font-size:11px;" onclick="_hwExportReport()">📥 Exportar</button>',
      '</div>',
    '</div>'
  );

  h.push(
    '<div style="background:linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%);border-radius:12px;padding:18px 20px;margin-bottom:16px;border:1px solid #bae6fd;">',
      '<div style="font-size:11px;font-weight:700;color:#0369a1;letter-spacing:.06em;margin-bottom:8px;">📋 RESUMO EXECUTIVO</div>',
      '<div style="font-size:14px;color:var(--text);line-height:1.7;">' + _sanitize(report.resumo_executivo || '') + '</div>',
    '</div>'
  );

  h.push(single ? _hwSingleCard(report) : _hwMultiCard(report));

  if (!report._aiPowered) {
    var errNote = report._apiError ? ' Erro: ' + _sanitize(report._apiError) : '';
    h.push(
      '<div style="margin-top:16px;padding:12px 16px;background:#fafafa;border:1px dashed #d1d5db;border-radius:8px;text-align:center;">',
        '<div style="font-size:12px;color:var(--text-3);">⚙️ Análise gerada localmente.' + errNote + ' Para IA real, configure <code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;">_HW_AI_CONFIG.apiKey</code>.</div>',
      '</div>'
    );
  }
  el.innerHTML = h.join('');
}
window._hwRenderReport = _hwRenderReport;

/* ─ Relatório proposta única ─ */
function _hwSingleCard(r) {
  var sc  = r.score           || 0;
  var adh = r.nivel_aderencia || 0;
  var scC = sc  >= 70 ? '#10b981' : sc  >= 45 ? '#f59e0b' : '#ef4444';
  var adC = adh >= 70 ? '#10b981' : adh >= 45 ? '#f59e0b' : '#ef4444';
  var VS  = {
    CONTRATAR: 'background:#dcfce7;color:#166534;border-color:#86efac',
    NEGOCIAR:  'background:#fef3c7;color:#92400e;border-color:#fcd34d',
    RECUSAR:   'background:#fee2e2;color:#991b1b;border-color:#fca5a5'
  };
  var VE  = { CONTRATAR: '✅', NEGOCIAR: '🤝', RECUSAR: '❌' };
  var vs  = VS[r.veredicto] || VS.NEGOCIAR;
  var ve  = VE[r.veredicto] || '🤝';
  var h   = [];
  h.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">',
    _hwMeter('Score Geral', sc, scC),
    _hwMeter('Aderência ao Projeto', adh, adC),
  '</div>');
  if ((r.pontos_fortes || []).length) h.push(_hwListBox('✅ PONTOS FORTES',    r.pontos_fortes, '#f0fdf4', '#166534', '#bbf7d0'));
  if ((r.pontos_fracos || []).length) h.push(_hwListBox('⚠️ PONTOS DE ATENÇÃO', r.pontos_fracos, '#fff7ed', '#c2410c', '#fed7aa'));
  var hasR = (r.riscos || []).length > 0;
  var hasO = (r.oportunidades || []).length > 0;
  if (hasR || hasO) {
    h.push('<div style="display:grid;grid-template-columns:' + (hasR && hasO ? '1fr 1fr' : '1fr') + ';gap:12px;margin-bottom:14px;">');
    if (hasR) h.push(_hwListBoxSm('🚨 RISCOS',        r.riscos,        '#fef2f2', '#991b1b', '#fecaca'));
    if (hasO) h.push(_hwListBoxSm('💡 OPORTUNIDADES', r.oportunidades, '#eff6ff', '#1d4ed8', '#bfdbfe'));
    h.push('</div>');
  }
  h.push(
    '<div style="' + vs + ';border-radius:12px;padding:20px;border:2px solid;">',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">',
        '<span style="font-size:28px;">' + ve + '</span>',
        '<div>',
          '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;opacity:.65;">VEREDICTO DA IA</div>',
          '<div style="font-size:17px;font-weight:900;">' + _sanitize(r.recomendacao || r.veredicto || '') + '</div>',
        '</div>',
      '</div>',
      '<div style="font-size:13px;line-height:1.7;opacity:.85;">' + _sanitize(r.justificativa || '') + '</div>',
    '</div>'
  );
  return h.join('');
}

/* ─ Relatório múltiplas propostas ─ */
function _hwMultiCard(r) {
  var medals = ['🥇', '🥈', '🥉'];
  var h = [];
  if ((r.ranking || []).length) {
    h.push(
      '<div style="background:var(--surface,#f9fafb);border-radius:12px;padding:16px 18px;margin-bottom:16px;border:1px solid var(--border);">',
        '<div style="font-size:11px;font-weight:700;color:var(--text-3);letter-spacing:.06em;margin-bottom:12px;">🏆 RANKING GERAL</div>',
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">',
        (r.ranking || []).slice(0, 5).map(function(nm, i) {
          return '<div style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:20px;border:1px solid var(--border);background:var(--bg);font-size:13px;font-weight:700;">' + (medals[i] || (i + 1) + 'º') + '&nbsp;' + _sanitize(nm) + '</div>';
        }).join(''),
        '</div>',
      '</div>'
    );
  }
  h.push(
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">',
      '<div style="background:#f0fdf4;border-radius:10px;padding:14px 16px;border:1px solid #bbf7d0;text-align:center;">',
        '<div style="font-size:10px;font-weight:700;color:#166534;letter-spacing:.05em;margin-bottom:5px;">💰 MELHOR CUSTO-BENEFÍCIO</div>',
        '<div style="font-size:15px;font-weight:800;color:var(--text);">' + _sanitize(r.melhor_custo_beneficio || '—') + '</div>',
      '</div>',
      '<div style="background:#eff6ff;border-radius:10px;padding:14px 16px;border:1px solid #bfdbfe;text-align:center;">',
        '<div style="font-size:10px;font-weight:700;color:#1d4ed8;letter-spacing:.05em;margin-bottom:5px;">⭐ MELHOR QUALIFICAÇÃO</div>',
        '<div style="font-size:15px;font-weight:800;color:var(--text);">' + _sanitize(r.melhor_qualificacao || '—') + '</div>',
      '</div>',
    '</div>'
  );
  (r.propostas || []).forEach(function(p, i) {
    var rank = (r.ranking || []).indexOf(p.freelancer);
    var med  = rank >= 0 ? (medals[rank] || (rank + 1) + 'º') : (i + 1) + 'º';
    var isT  = rank === 0;
    var sc   = p.score || 0;
    var scC  = sc >= 70 ? '#10b981' : sc >= 45 ? '#f59e0b' : '#ef4444';
    h.push(
      '<div style="border-radius:12px;padding:16px;margin-bottom:12px;border:' + (isT ? '2px solid #10b981;background:#f0fdf4' : '1px solid var(--border);background:var(--surface,#f9fafb)') + ';">',
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">',
          '<span style="font-size:22px;flex-shrink:0;">' + med + '</span>',
          '<div style="flex:1;font-size:14.5px;font-weight:700;color:var(--text);">' + _sanitize(p.freelancer || 'Freelancer') + '</div>',
          '<div style="font-size:28px;font-weight:900;color:' + scC + ';line-height:1;">' + sc + '<span style="font-size:12px;opacity:.5;">/100</span></div>',
        '</div>',
        '<div style="background:rgba(0,0,0,.08);border-radius:4px;height:7px;overflow:hidden;margin-bottom:12px;">',
          '<div style="height:100%;width:' + sc + '%;background:' + scC + ';border-radius:4px;"></div>',
        '</div>',
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">',
          '<div>',
            '<div style="font-weight:700;color:#166534;margin-bottom:4px;">✅ Fortes</div>',
            (p.pontos_fortes || ['—']).map(function(s) {
              return '<div style="color:var(--text-2);padding:2px 0;line-height:1.4;">&bull; ' + _sanitize(s) + '</div>';
            }).join(''),
          '</div>',
          '<div>',
            '<div style="font-weight:700;color:#c2410c;margin-bottom:4px;">⚠️ Atenção</div>',
            (p.pontos_fracos || ['—']).map(function(s) {
              return '<div style="color:var(--text-2);padding:2px 0;line-height:1.4;">&bull; ' + _sanitize(s) + '</div>';
            }).join(''),
          '</div>',
        '</div>',
        p.risco_principal
          ? '<div style="font-size:11.5px;background:#fef3c7;color:#92400e;border-radius:6px;padding:6px 10px;margin-top:10px;">🚨 ' + _sanitize(p.risco_principal) + '</div>'
          : '',
      '</div>'
    );
  });
  if ((r.riscos_gerais || []).length) {
    h.push(
      '<div style="background:#fef2f2;border-radius:10px;padding:14px 16px;margin-bottom:16px;border:1px solid #fecaca;">',
        '<div style="font-size:11px;font-weight:700;color:#991b1b;letter-spacing:.06em;margin-bottom:8px;">🚨 RISCOS IDENTIFICADOS</div>',
        (r.riscos_gerais || []).map(function(s) {
          return '<div style="font-size:13px;color:var(--text);padding:4px 0;">&bull; ' + _sanitize(s) + '</div>';
        }).join(''),
      '</div>'
    );
  }
  h.push(
    '<div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-radius:12px;padding:20px;border:2px solid #86efac;">',
      '<div style="font-size:11px;font-weight:700;color:#166534;letter-spacing:.06em;margin-bottom:8px;">🎯 RECOMENDAÇÃO FINAL DA IA</div>',
      '<div style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:10px;">👤 ' + _sanitize(r.recomendacao || '—') + '</div>',
      '<div style="font-size:13px;line-height:1.75;color:var(--text-2);">' + _sanitize(r.justificativa || '') + '</div>',
    '</div>'
  );
  return h.join('');
}

/* ─ Helpers de UI ─ */
function _hwMeter(label, val, color) {
  return [
    '<div style="text-align:center;background:var(--surface,#f9fafb);border-radius:12px;padding:18px 12px;border:1px solid var(--border);">',
      '<div style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:.06em;margin-bottom:8px;">' + label.toUpperCase() + '</div>',
      '<div style="font-size:38px;font-weight:900;color:' + color + ';line-height:1;">' + val + '</div>',
      '<div style="font-size:11px;color:var(--text-4);margin-top:2px;">/100</div>',
      '<div style="margin-top:9px;background:var(--border);border-radius:4px;height:6px;overflow:hidden;">',
        '<div style="height:100%;width:' + val + '%;background:' + color + ';border-radius:4px;"></div>',
      '</div>',
    '</div>'
  ].join('');
}
function _hwListBox(title, items, bg, tc, bc) {
  return [
    '<div style="background:' + bg + ';border-radius:10px;padding:14px 16px;margin-bottom:12px;border:1px solid ' + bc + ';">',
      '<div style="font-size:11px;font-weight:700;color:' + tc + ';letter-spacing:.06em;margin-bottom:8px;">' + title + '</div>',
      (items || []).map(function(s) {
        return '<div style="font-size:13px;color:var(--text);padding:4px 0;border-bottom:1px solid ' + bc + ';">&bull; ' + _sanitize(s) + '</div>';
      }).join(''),
    '</div>'
  ].join('');
}
function _hwListBoxSm(title, items, bg, tc, bc) {
  return [
    '<div style="background:' + bg + ';border-radius:10px;padding:13px 15px;border:1px solid ' + bc + ';">',
      '<div style="font-size:11px;font-weight:700;color:' + tc + ';letter-spacing:.06em;margin-bottom:6px;">' + title + '</div>',
      (items || []).map(function(s) {
        return '<div style="font-size:12.5px;color:var(--text);padding:3px 0;">&bull; ' + _sanitize(s) + '</div>';
      }).join(''),
    '</div>'
  ].join('');
}

/* ── Exportar relatório como .txt ── */
function _hwExportReport() {
  var ctx    = window._pmodCtx;
  var report = ctx && _hwAiCache[ctx.projectId];
  if (!report) { showToast('Nenhum relatório disponível para exportar.', 'info'); return; }
  var lines = [
    '══════════════════════════════════════════════',
    '  RELATÓRIO DE ANÁLISE DE PROPOSTAS — HEREWORK',
    '══════════════════════════════════════════════',
    ' Projeto  : ' + (report._projTitle  || ''),
    ' Data     : ' + new Date(report._analyzedAt || '').toLocaleString('pt-BR'),
    ' Propostas: ' + (report._proposalCnt || 1),
    ' PDFs lidos: ' + (report._pdfCount   || 0),
    ' Fonte    : ' + (report._aiPowered ? 'IA Real' : 'Simulação local'),
    '══════════════════════════════════════════════',
    '', 'RESUMO EXECUTIVO', '────────────────',
    report.resumo_executivo || '', ''
  ];
  if (report.propostas) {
    lines.push('RANKING: ' + (report.ranking || []).join(' › '));
    lines.push('Melhor custo-benefício: ' + (report.melhor_custo_beneficio || ''));
    lines.push('Melhor qualificação   : ' + (report.melhor_qualificacao    || ''));
    lines.push('');
    (report.propostas || []).forEach(function(p, i) {
      lines.push('─── ' + (i + 1) + 'º: ' + (p.freelancer || '') + '  (Score: ' + (p.score || 0) + '/100) ───');
      lines.push('Fortes : ' + (p.pontos_fortes || []).join('; '));
      lines.push('Atenção: ' + (p.pontos_fracos || []).join('; '));
      if (p.risco_principal) lines.push('Risco  : ' + p.risco_principal);
      lines.push('');
    });
    if ((report.riscos_gerais || []).length) {
      lines.push('RISCOS GERAIS: ' + report.riscos_gerais.join('; '));
      lines.push('');
    }
    lines.push('RECOMENDAÇÃO: ' + (report.recomendacao || ''));
    lines.push('');
    lines.push('JUSTIFICATIVA:');
    lines.push(report.justificativa || '');
  } else {
    lines.push('Score: ' + (report.score || 0) + '/100  |  Aderência: ' + (report.nivel_aderencia || 0) + '/100  |  Veredicto: ' + (report.veredicto || ''));
    lines.push('');
    if ((report.pontos_fortes  || []).length) { lines.push('FORTES    : ' + report.pontos_fortes.join('; ')); lines.push(''); }
    if ((report.pontos_fracos  || []).length) { lines.push('ATENÇÃO   : ' + report.pontos_fracos.join('; ')); lines.push(''); }
    if ((report.riscos         || []).length) { lines.push('RISCOS    : ' + report.riscos.join('; '));         lines.push(''); }
    if ((report.oportunidades  || []).length) { lines.push('OPORTUNIDADES: ' + report.oportunidades.join('; ')); lines.push(''); }
    lines.push('RECOMENDAÇÃO: ' + (report.recomendacao || ''));
    lines.push('');
    lines.push('JUSTIFICATIVA:');
    lines.push(report.justificativa || '');
  }
  var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  var a    = document.createElement('a');
  a.href   = URL.createObjectURL(blob);
  a.download = 'analise-' + (report._projTitle || 'projeto').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase() + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('📥 Relatório exportado!', 'success');
}
window._hwExportReport = _hwExportReport;

/* ══════════════════════════════════════════════════════════════════
   HOOK: sobrescreve _renderAiPanel para disparar a análise por IA
   ══════════════════════════════════════════════════════════════════ */
window._renderAiPanel = function() { _hwAnalyzeProposals(false); };

</script>
`;

html = html.replace('</body>', newScript + '</body>');
fs.writeFileSync('app.html', html);
console.log('Done. New line count:', html.split('\n').length);
