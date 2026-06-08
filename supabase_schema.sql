-- ═══════════════════════════════════════════════════════════════
--  HEREWORK — Schema completo Supabase
--  Execute este arquivo no SQL Editor do Supabase
-- ═══════════════════════════════════════════════════════════════

-- Habilitar extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. PERFIS DE USUÁRIOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID        REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  type          TEXT        NOT NULL DEFAULT 'client' CHECK (type IN ('client','freelancer')),
  bio           TEXT,
  avatar_url    TEXT,
  city          TEXT,
  state         TEXT,
  phone         TEXT,
  hourly_rate   DECIMAL(10,2),
  rating        DECIMAL(3,2) DEFAULT 5.00,
  rating_count  INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  skills        TEXT[],
  plan          TEXT DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 2. PROJETOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id            UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  client_id     UUID        REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title         TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  budget_min    DECIMAL(10,2),
  budget_max    DECIMAL(10,2),
  deadline_days INTEGER,
  type          TEXT        DEFAULT 'fixo' CHECK (type IN ('fixo','recorrente')),
  status        TEXT        DEFAULT 'open' CHECK (status IN ('open','in_progress','review','completed','cancelled')),
  views         INTEGER     DEFAULT 0,
  proposal_count INTEGER    DEFAULT 0,
  skills_needed TEXT[],
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 3. PROPOSTAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposals (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  project_id      UUID    REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  freelancer_id   UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  value           DECIMAL(10,2) NOT NULL,
  deadline_days   INTEGER NOT NULL,
  cover_letter    TEXT    NOT NULL,
  status          TEXT    DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, freelancer_id)
);

-- ─────────────────────────────────────────────
-- 4. CONTRATOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  project_id      UUID    REFERENCES projects(id),
  proposal_id     UUID    REFERENCES proposals(id),
  client_id       UUID    REFERENCES profiles(id) NOT NULL,
  freelancer_id   UUID    REFERENCES profiles(id) NOT NULL,
  title           TEXT    NOT NULL,
  value           DECIMAL(10,2) NOT NULL,
  deadline_days   INTEGER NOT NULL,
  status          TEXT    DEFAULT 'active' CHECK (status IN ('active','review','revision','completed','disputed','cancelled')),
  escrow_released BOOLEAN DEFAULT FALSE,
  paid_at         TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 5. MENSAGENS DO CHAT
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  contract_id UUID    REFERENCES contracts(id) ON DELETE CASCADE NOT NULL,
  sender_id   UUID    REFERENCES profiles(id) NOT NULL,
  content     TEXT    NOT NULL,
  type        TEXT    DEFAULT 'text' CHECK (type IN ('text','file','system')),
  file_url    TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 6. AVALIAÇÕES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id           UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  contract_id  UUID    REFERENCES contracts(id) ON DELETE CASCADE NOT NULL,
  reviewer_id  UUID    REFERENCES profiles(id) NOT NULL,
  reviewed_id  UUID    REFERENCES profiles(id) NOT NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contract_id, reviewer_id)
);

-- ─────────────────────────────────────────────
-- 7. CANDIDATURAS (CARREIRAS)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_applications (
  id           UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  name         TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  position     TEXT    NOT NULL,
  motivation   TEXT    NOT NULL,
  cv_url       TEXT,
  status       TEXT    DEFAULT 'pending' CHECK (status IN ('pending','reviewing','approved','rejected')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 8. INSCRIÇÕES NEWSLETTER
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_subscriptions (
  id         UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  email      TEXT    NOT NULL UNIQUE,
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 9. TICKETS DE SUPORTE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID    REFERENCES profiles(id),
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  description TEXT    NOT NULL,
  protocol    TEXT    NOT NULL UNIQUE,
  status      TEXT    DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- TRIGGERS — atualizar updated_at automaticamente
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated   BEFORE UPDATE ON profiles   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated   BEFORE UPDATE ON projects   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_contracts_updated  BEFORE UPDATE ON contracts  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- TRIGGER — criar perfil automaticamente após signup
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email, type)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'type', 'client')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NEW; -- nunca bloquear o cadastro por falha no perfil
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ═══════════════════════════════════════════════════════════════
-- RLS — Row Level Security (segurança por linha)
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects              ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews               ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscriptions ENABLE ROW LEVEL SECURITY;

-- Profiles: qualquer um lê, só o dono edita
CREATE POLICY "profiles_read"   ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (true); -- trigger cria com SECURITY DEFINER
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Projects: qualquer um lê, só o cliente dono cria/edita
CREATE POLICY "projects_read"   ON projects FOR SELECT USING (true);
CREATE POLICY "projects_insert" ON projects FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "projects_update" ON projects FOR UPDATE USING (auth.uid() = client_id);
-- Projects: exclusão — autor da publicação OU administrador do sistema (profiles.is_admin = true).
-- Sem esta policy o botão "Excluir" do app falha silenciosamente (RLS bloqueia o DELETE).
CREATE POLICY "projects_delete" ON projects FOR DELETE USING (
  auth.uid() = client_id
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

-- Proposals: freelancer cria, partes envolvidas lêem
CREATE POLICY "proposals_read"   ON proposals FOR SELECT USING (auth.uid() = freelancer_id OR auth.uid() = (SELECT client_id FROM projects WHERE id = project_id));
CREATE POLICY "proposals_insert" ON proposals FOR INSERT WITH CHECK (auth.uid() = freelancer_id);
CREATE POLICY "proposals_update" ON proposals FOR UPDATE USING (auth.uid() = freelancer_id);

-- Contracts: só as partes envolvidas
CREATE POLICY "contracts_read"   ON contracts FOR SELECT USING (auth.uid() = client_id OR auth.uid() = freelancer_id);
CREATE POLICY "contracts_insert" ON contracts FOR INSERT WITH CHECK (auth.uid() = client_id);
CREATE POLICY "contracts_update" ON contracts FOR UPDATE USING (auth.uid() = client_id OR auth.uid() = freelancer_id);

-- Messages: só quem é parte do contrato
CREATE POLICY "messages_read"   ON messages FOR SELECT USING (auth.uid() IN (SELECT client_id FROM contracts WHERE id = contract_id UNION SELECT freelancer_id FROM contracts WHERE id = contract_id));
CREATE POLICY "messages_insert" ON messages FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- Reviews: leitura pública, só quem fez o contrato avalia
CREATE POLICY "reviews_read"   ON reviews FOR SELECT USING (true);
CREATE POLICY "reviews_insert" ON reviews FOR INSERT WITH CHECK (auth.uid() = reviewer_id);

-- Tickets: usuário vê só os seus
CREATE POLICY "tickets_read"   ON support_tickets FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "tickets_insert" ON support_tickets FOR INSERT WITH CHECK (true);

-- Job applications: só admin vê (inserção pública)
CREATE POLICY "jobs_insert" ON job_applications FOR INSERT WITH CHECK (true);

-- Newsletter: inserção pública
CREATE POLICY "newsletter_insert" ON newsletter_subscriptions FOR INSERT WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- ÍNDICES para performance
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_projects_client    ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_category  ON projects(category);
CREATE INDEX IF NOT EXISTS idx_proposals_project  ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_fl       ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_client   ON contracts(client_id);
CREATE INDEX IF NOT EXISTS idx_contracts_fl       ON contracts(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_messages_contract  ON messages(contract_id);

-- ═══════════════════════════════════════════════════════════════
-- MIGRAÇÃO — Exclusão de publicações por administradores
-- (necessária para a policy "projects_delete" acima reconhecer admins)
-- Execute este bloco no SQL Editor do Supabase. Seguro para rodar em
-- bases já existentes — não afeta dados nem usuários atuais
-- (a coluna nasce com DEFAULT false, ninguém vira admin automaticamente).
-- Depois de rodar, marque manualmente o(s) usuário(s) administrador(es):
--   UPDATE profiles SET is_admin = true WHERE email = 'email-do-admin@herework.com.br';
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- ═══════════════════════════════════════════════════════════════
-- MIGRAÇÃO — Módulo de Propostas: suporte a anexos (PDFs, arquivos)
-- Execute no SQL Editor do Supabase. Seguro para rodar em bases
-- já existentes — a coluna nasce como array vazio por padrão.
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS attachments TEXT[] DEFAULT '{}';

-- ═══════════════════════════════════════════════════════════════
-- MIGRAÇÃO — Exclusão de projetos em cascata
--
-- PROBLEMA: o botão "Excluir" falha silenciosamente porque:
--   (a) Nenhuma policy RLS DELETE existe para projects/contracts/
--       proposals/messages → Supabase bloqueia sem retornar erro.
--   (b) contracts.project_id não tem ON DELETE CASCADE → a FK
--       impede a exclusão do projeto se houver contratos vinculados.
--
-- SOLUÇÃO: policies RLS + função RPC SECURITY DEFINER que executa
-- toda a cascata numa única transação, contornando as FKs individuais.
--
-- Execute este bloco inteiro no SQL Editor do Supabase.
-- Seguro para rodar múltiplas vezes (DROP ... IF EXISTS + IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════

-- 1. RLS policies DELETE em falta
-- (usa DROP IF EXISTS para ser idempotente)

DROP POLICY IF EXISTS "projects_delete" ON projects;
CREATE POLICY "projects_delete" ON projects FOR DELETE USING (
  auth.uid() = client_id
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

DROP POLICY IF EXISTS "contracts_delete" ON contracts;
CREATE POLICY "contracts_delete" ON contracts FOR DELETE USING (
  auth.uid() = client_id
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

DROP POLICY IF EXISTS "proposals_delete" ON proposals;
CREATE POLICY "proposals_delete" ON proposals FOR DELETE USING (
  auth.uid() = freelancer_id
  OR auth.uid() = (SELECT client_id FROM projects WHERE id = project_id)
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

DROP POLICY IF EXISTS "messages_delete" ON messages;
CREATE POLICY "messages_delete" ON messages FOR DELETE USING (
  auth.uid() IN (
    SELECT client_id    FROM contracts WHERE id = contract_id
    UNION
    SELECT freelancer_id FROM contracts WHERE id = contract_id
  )
);

-- 2. Função RPC de exclusão segura em cascata
--    SECURITY DEFINER: executa como owner (ignora RLS individualmente),
--    mas verifica ownership explicitamente antes de qualquer DELETE.
DROP FUNCTION IF EXISTS delete_project_cascade(UUID);
CREATE OR REPLACE FUNCTION delete_project_cascade(p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id   UUID;
  v_contract_ids UUID[];
BEGIN
  -- Buscar owner do projeto
  SELECT client_id INTO v_client_id
    FROM projects WHERE id = p_project_id;

  -- Projeto inexistente
  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'project_not_found');
  END IF;

  -- Verificar permissão: author ou admin
  IF v_client_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
  END IF;

  -- Coletar IDs de contratos vinculados
  SELECT ARRAY(SELECT id FROM contracts WHERE project_id = p_project_id)
    INTO v_contract_ids;

  -- Excluir em cascata (ordem respeita FK constraints)
  IF v_contract_ids IS NOT NULL AND array_length(v_contract_ids, 1) > 0 THEN
    DELETE FROM messages  WHERE contract_id = ANY(v_contract_ids);
    DELETE FROM contracts WHERE project_id  = p_project_id;
  END IF;

  DELETE FROM proposals WHERE project_id = p_project_id;
  DELETE FROM projects  WHERE id         = p_project_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Garantir que apenas usuários autenticados possam chamar a função
REVOKE ALL ON FUNCTION delete_project_cascade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_project_cascade(UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- MIGRAÇÃO — Perfil Dual (Cliente + Freelancer)
--
-- Permite que um único usuário atue como Cliente, Freelancer ou Ambos.
-- Altera o CHECK constraint da coluna `type` da tabela `profiles`
-- para aceitar o novo valor 'both'.
--
-- Execute no SQL Editor do Supabase. Seguro para rodar múltiplas vezes.
-- Nenhum dado existente é afetado (usuários atuais permanecem 'client'
-- ou 'freelancer' até atualizarem o perfil).
-- ═══════════════════════════════════════════════════════════════

-- 1. Remove o constraint antigo e recria aceitando 'both'
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_type_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_type_check
  CHECK (type IN ('client', 'freelancer', 'both'));

-- 2. Atualiza o DEFAULT (mantém 'client' como padrão)
-- (o DEFAULT já é 'client', nenhuma alteração necessária)

-- 3. Garante que a coluna aceita o novo valor
-- (já garantido pelo constraint acima)

-- Verificação opcional: retorna todos os tipos distintos existentes
-- SELECT DISTINCT type FROM profiles;
