-- ═══════════════════════════════════════════════════════════════
--  HEREWORK — Schema completo Supabase  (from-scratch, idempotente)
--  Execute este arquivo no SQL Editor do Supabase.
--  Seguro para rodar em base existente: usa IF NOT EXISTS / OR REPLACE.
--
--  Para bases já existentes, prefira o arquivo:
--    supabase_migration_all.sql  (aplica apenas o delta)
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- Extensões
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- 1. PERFIS DE USUÁRIOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id               UUID        REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  name             TEXT        NOT NULL,
  email            TEXT        NOT NULL,
  type             TEXT        NOT NULL DEFAULT 'client'
                               CHECK (type IN ('client','freelancer','both')),
  bio              TEXT,
  avatar_url       TEXT,
  city             TEXT,
  state            TEXT,
  phone            TEXT,
  hourly_rate      DECIMAL(10,2),
  rating           DECIMAL(3,2) DEFAULT 5.00,
  rating_count     INTEGER DEFAULT 0,
  completed_jobs   INTEGER DEFAULT 0,
  skills           TEXT[],
  plan             TEXT DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  is_admin         BOOLEAN NOT NULL DEFAULT false,
  profile_metadata JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_metadata
  ON profiles USING GIN (profile_metadata);
CREATE INDEX IF NOT EXISTS idx_profiles_type ON profiles(type);
CREATE INDEX IF NOT EXISTS idx_profiles_city ON profiles(city);
CREATE INDEX IF NOT EXISTS idx_profiles_rate ON profiles(hourly_rate);

COMMENT ON COLUMN profiles.profile_metadata IS
'Dados extendidos do freelancer. Campos esperados:
  title TEXT                 — Título profissional
  linkedin_url TEXT          — URL do LinkedIn
  portfolio_url TEXT         — URL do site/portfólio principal
  portfolio_1..3 TEXT        — Links adicionais de portfólio
  timezone TEXT              — Ex: "-3"
  hourly_rate NUMERIC        — Valor hora em R$
  project_min NUMERIC        — Valor mínimo por projeto em R$
  exp_years TEXT             — Ex: "3-5"
  exp_level TEXT             — iniciante|intermediario|senior|especialista
  billing_prefs TEXT         — CSV: hora,projeto,mensal,combinar
  availability TEXT          — disponivel|breve|ocupado
  hours_week TEXT            — Ex: "20"
  work_regime TEXT           — CSV: remoto,hibrido,presencial
  proj_prefs TEXT            — CSV: curto,medio,longo,recorrente
  languages TEXT             — CSV: pt,en,es,fr,de,it,zh,ja,outro
  tools TEXT[]               — Ferramentas do dia a dia
  ai_use TEXT                — sim|as-vezes|nao
  ai_tools TEXT              — CSV: chatgpt,claude,gemini,midjourney,copilot,n8n,outras
  education_level TEXT       — medio|tecnico|graduacao|pos|mestrado|doutorado
  education_area TEXT        — Ex: "Ciência da Computação"
  certifications TEXT        — Certificações em texto livre
  communication_prefs JSONB  — Preferências de notificação
';

-- ─────────────────────────────────────────────
-- 2. PROJETOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id      UUID        REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title          TEXT        NOT NULL,
  description    TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  budget_min     DECIMAL(10,2),
  budget_max     DECIMAL(10,2),
  deadline_days  INTEGER,
  type           TEXT        DEFAULT 'fixo' CHECK (type IN ('fixo','recorrente')),
  status         TEXT        DEFAULT 'open'
                             CHECK (status IN ('open','in_progress','review','completed','cancelled')),
  views          INTEGER     DEFAULT 0,
  proposal_count INTEGER     DEFAULT 0,
  skills_needed  TEXT[],
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_client   ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category);
CREATE INDEX IF NOT EXISTS idx_projects_created  ON projects(created_at DESC);

-- ─────────────────────────────────────────────
-- 3. PROPOSTAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposals (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id    UUID    REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  freelancer_id UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  value         DECIMAL(10,2) NOT NULL,
  deadline_days INTEGER NOT NULL,
  cover_letter  TEXT    NOT NULL,
  status        TEXT    DEFAULT 'pending'
                        CHECK (status IN ('pending','viewed','shortlisted','accepted','rejected','withdrawn')),
  attachments   TEXT[]  DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, freelancer_id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_fl      ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status  ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at DESC);

-- ─────────────────────────────────────────────
-- 4. CONTRATOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      UUID    REFERENCES projects(id),
  proposal_id     UUID    REFERENCES proposals(id),
  client_id       UUID    REFERENCES profiles(id) NOT NULL,
  freelancer_id   UUID    REFERENCES profiles(id) NOT NULL,
  title           TEXT    NOT NULL,
  value           DECIMAL(10,2) NOT NULL,
  deadline_days   INTEGER NOT NULL,
  status          TEXT    DEFAULT 'active'
                          CHECK (status IN ('active','review','revision','completed','disputed','cancelled','pending_acceptance','awaiting_release')),
  escrow_released          BOOLEAN DEFAULT FALSE,
  stripe_transfer_id       TEXT,
  started_at               TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_id);
CREATE INDEX IF NOT EXISTS idx_contracts_fl     ON contracts(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- ─────────────────────────────────────────────
-- 5. MENSAGENS DO CHAT
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID    REFERENCES contracts(id) ON DELETE CASCADE NOT NULL,
  sender_id   UUID    REFERENCES profiles(id) NOT NULL,
  content     TEXT    NOT NULL,
  type        TEXT    DEFAULT 'text' CHECK (type IN ('text','file','system')),
  file_url    TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_contract ON messages(contract_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id);

-- ─────────────────────────────────────────────
-- 6. AVALIAÇÕES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID    REFERENCES contracts(id) ON DELETE CASCADE NOT NULL,
  reviewer_id UUID    REFERENCES profiles(id) NOT NULL,
  reviewed_id UUID    REFERENCES profiles(id) NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contract_id, reviewer_id)
);

-- ─────────────────────────────────────────────
-- 7. CANDIDATURAS (CARREIRAS)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_applications (
  id         UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  position   TEXT    NOT NULL,
  motivation TEXT    NOT NULL,
  cv_url     TEXT,
  status     TEXT    DEFAULT 'pending'
                     CHECK (status IN ('pending','reviewing','approved','rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 8. INSCRIÇÕES NEWSLETTER
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_subscriptions (
  id         UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  email      TEXT    NOT NULL UNIQUE,
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 9. TICKETS DE SUPORTE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID    REFERENCES profiles(id),
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  description TEXT    NOT NULL,
  protocol    TEXT    NOT NULL UNIQUE,
  status      TEXT    DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 10. PREFERÊNCIAS DE NOTIFICAÇÃO
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email_proposals  BOOLEAN NOT NULL DEFAULT true,
  email_messages   BOOLEAN NOT NULL DEFAULT true,
  email_contracts  BOOLEAN NOT NULL DEFAULT true,
  email_newsletter BOOLEAN NOT NULL DEFAULT false,
  blog_newsletter  BOOLEAN NOT NULL DEFAULT false,
  new_projects     BOOLEAN NOT NULL DEFAULT true,
  new_proposals    BOOLEAN NOT NULL DEFAULT true,
  promotions       BOOLEAN NOT NULL DEFAULT false,
  monthly_report   BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ─────────────────────────────────────────────
-- 11. LOG DE E-MAILS (anti-deduplicação)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ref_id     UUID,
  status     TEXT NOT NULL DEFAULT 'sent',
  error_msg  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_user    ON email_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC);

-- ─────────────────────────────────────────────
-- 12. SOLICITAÇÕES DE DIREITOS DO TITULAR (LGPD Art. 18)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deletion_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  user_email   TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'delete'
               CHECK (request_type IN ('delete','export','rectify')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','completed','rejected')),
  protocol     TEXT NOT NULL UNIQUE,
  notes        TEXT,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- FUNÇÕES E TRIGGERS
-- ═══════════════════════════════════════════════════════════════

-- updated_at automático
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_profiles_updated') THEN
    CREATE TRIGGER trg_profiles_updated   BEFORE UPDATE ON profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_projects_updated') THEN
    CREATE TRIGGER trg_projects_updated   BEFORE UPDATE ON projects
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_contracts_updated') THEN
    CREATE TRIGGER trg_contracts_updated  BEFORE UPDATE ON contracts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_proposals_updated') THEN
    CREATE TRIGGER trg_proposals_updated  BEFORE UPDATE ON proposals
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notif_prefs_updated') THEN
    CREATE TRIGGER trg_notif_prefs_updated BEFORE UPDATE ON notification_preferences
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- Criar perfil automaticamente após signup
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_created') THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_user();
  END IF;
END$$;

-- ═══════════════════════════════════════════════════════════════
-- FUNÇÃO RPC: exclusão em cascata de projeto (SECURITY DEFINER)
-- ═══════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS delete_project_cascade(UUID);
CREATE OR REPLACE FUNCTION delete_project_cascade(p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id    UUID;
  v_contract_ids UUID[];
BEGIN
  SELECT client_id INTO v_client_id FROM projects WHERE id = p_project_id;
  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'project_not_found');
  END IF;
  IF v_client_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
  END IF;
  SELECT ARRAY(SELECT id FROM contracts WHERE project_id = p_project_id)
    INTO v_contract_ids;
  IF v_contract_ids IS NOT NULL AND array_length(v_contract_ids, 1) > 0 THEN
    DELETE FROM messages  WHERE contract_id = ANY(v_contract_ids);
    DELETE FROM contracts WHERE project_id  = p_project_id;
  END IF;
  DELETE FROM proposals WHERE project_id = p_project_id;
  DELETE FROM projects  WHERE id         = p_project_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION delete_project_cascade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_project_cascade(UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE profiles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_logs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests         ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "profiles_read"   ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;
CREATE POLICY "profiles_read"   ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id AND COALESCE(is_admin, false) = false);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- projects
DROP POLICY IF EXISTS "projects_read"   ON projects;
DROP POLICY IF EXISTS "projects_insert" ON projects;
DROP POLICY IF EXISTS "projects_update" ON projects;
DROP POLICY IF EXISTS "projects_delete" ON projects;
CREATE POLICY "projects_read"   ON projects FOR SELECT USING (true);
CREATE POLICY "projects_insert" ON projects FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "projects_update" ON projects FOR UPDATE USING (auth.uid() = client_id);
CREATE POLICY "projects_delete" ON projects FOR DELETE USING (
  auth.uid() = client_id
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

-- proposals — consolidado (freelancer + client)
DROP POLICY IF EXISTS "proposals_read"     ON proposals;
DROP POLICY IF EXISTS "proposals_insert"   ON proposals;
DROP POLICY IF EXISTS "proposals_update"   ON proposals;
DROP POLICY IF EXISTS "proposals_delete"   ON proposals;
DROP POLICY IF EXISTS "proposals_freelancer" ON proposals;
DROP POLICY IF EXISTS "proposals_client"     ON proposals;
CREATE POLICY "proposals_freelancer"
  ON proposals FOR ALL
  USING (auth.uid() = freelancer_id)
  WITH CHECK (auth.uid() = freelancer_id);
CREATE POLICY "proposals_client"
  ON proposals FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = proposals.project_id
        AND p.client_id = auth.uid()
    )
  );

-- contracts
DROP POLICY IF EXISTS "contracts_read"   ON contracts;
DROP POLICY IF EXISTS "contracts_insert" ON contracts;
DROP POLICY IF EXISTS "contracts_update" ON contracts;
DROP POLICY IF EXISTS "contracts_delete" ON contracts;
CREATE POLICY "contracts_read"   ON contracts FOR SELECT USING (auth.uid() = client_id OR auth.uid() = freelancer_id);
CREATE POLICY "contracts_insert" ON contracts FOR INSERT WITH CHECK (auth.uid() = client_id);
CREATE POLICY "contracts_update" ON contracts FOR UPDATE USING (auth.uid() = client_id OR auth.uid() = freelancer_id);
CREATE POLICY "contracts_delete" ON contracts FOR DELETE USING (
  auth.uid() = client_id
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

-- messages
DROP POLICY IF EXISTS "messages_read"   ON messages;
DROP POLICY IF EXISTS "messages_insert" ON messages;
DROP POLICY IF EXISTS "messages_delete" ON messages;
CREATE POLICY "messages_read"   ON messages FOR SELECT USING (
  auth.uid() IN (
    SELECT client_id     FROM contracts WHERE id = contract_id
    UNION
    SELECT freelancer_id FROM contracts WHERE id = contract_id
  )
);
CREATE POLICY "messages_insert" ON messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "messages_delete" ON messages FOR DELETE USING (
  auth.uid() IN (
    SELECT client_id     FROM contracts WHERE id = contract_id
    UNION
    SELECT freelancer_id FROM contracts WHERE id = contract_id
  )
);

-- reviews
DROP POLICY IF EXISTS "reviews_read"   ON reviews;
DROP POLICY IF EXISTS "reviews_insert" ON reviews;
CREATE POLICY "reviews_read"   ON reviews FOR SELECT USING (true);
CREATE POLICY "reviews_insert" ON reviews FOR INSERT WITH CHECK (auth.uid() = reviewer_id);

-- support_tickets
DROP POLICY IF EXISTS "tickets_read"   ON support_tickets;
DROP POLICY IF EXISTS "tickets_insert" ON support_tickets;
CREATE POLICY "tickets_read"   ON support_tickets FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "tickets_insert" ON support_tickets FOR INSERT WITH CHECK (true);

-- job_applications (inserção pública, leitura apenas admin)
DROP POLICY IF EXISTS "jobs_insert" ON job_applications;
CREATE POLICY "jobs_insert" ON job_applications FOR INSERT WITH CHECK (true);

-- newsletter
DROP POLICY IF EXISTS "newsletter_insert" ON newsletter_subscriptions;
CREATE POLICY "newsletter_insert" ON newsletter_subscriptions FOR INSERT WITH CHECK (true);

-- notification_preferences
DROP POLICY IF EXISTS "notif_prefs_all" ON notification_preferences;
CREATE POLICY "notif_prefs_all"
  ON notification_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- email_logs
DROP POLICY IF EXISTS "email_logs_read" ON email_logs;
CREATE POLICY "email_logs_read"
  ON email_logs FOR SELECT
  USING (auth.uid() = user_id);

-- deletion_requests (LGPD)
DROP POLICY IF EXISTS "deletion_req_insert" ON deletion_requests;
DROP POLICY IF EXISTS "deletion_req_read"   ON deletion_requests;
CREATE POLICY "deletion_req_insert"
  ON deletion_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "deletion_req_read"
  ON deletion_requests FOR SELECT
  USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE proposals;  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE contracts;  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE messages;   EXCEPTION WHEN OTHERS THEN NULL; END;
END$$;

-- ═══════════════════════════════════════════════════════════════
-- ADMIN INICIAL — descomente e substitua pelo e-mail correto:
-- UPDATE profiles SET is_admin = true WHERE email = 'admin@herework.com.br';
-- ═══════════════════════════════════════════════════════════════
-- FIM DO SCHEMA
-- ═══════════════════════════════════════════════════════════════
