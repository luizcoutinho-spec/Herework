-- ═══════════════════════════════════════════════════════════════
--  HereWork — Migração Consolidada (aplica todas as alterações)
--  Execute no Supabase Dashboard → SQL Editor → New query
--  Idempotente: seguro para executar múltiplas vezes.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. Extensões
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- 2. Coluna `is_admin` em profiles
-- ─────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────
-- 3. Coluna `profile_metadata` JSONB em profiles
-- ─────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS profile_metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_profiles_metadata
  ON profiles USING GIN (profile_metadata);

-- ─────────────────────────────────────────────
-- 4. Tipo de conta 'both' no CHECK constraint
-- ─────────────────────────────────────────────
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_type_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_type_check
  CHECK (type IN ('client', 'freelancer', 'both'));

-- ─────────────────────────────────────────────
-- 5. Propostas: coluna `status` com enum completo
--    (inclui viewed, shortlisted, withdrawn)
-- ─────────────────────────────────────────────
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'proposals' AND column_name = 'status'
  ) THEN
    ALTER TABLE proposals
      ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  END IF;
END$$;

ALTER TABLE proposals
  ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('pending','viewed','shortlisted','accepted','rejected','withdrawn'));

-- ─────────────────────────────────────────────
-- 6. Propostas: coluna `updated_at`
-- ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'proposals' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE proposals ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END$$;

-- ─────────────────────────────────────────────
-- 7. Propostas: coluna `attachments` (PDFs)
-- ─────────────────────────────────────────────
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS attachments TEXT[] DEFAULT '{}';

-- ─────────────────────────────────────────────
-- 8. Contratos: coluna `started_at`
-- ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'started_at'
  ) THEN
    ALTER TABLE contracts ADD COLUMN started_at TIMESTAMPTZ;
  END IF;
END$$;

-- ─────────────────────────────────────────────
-- 9. Função e trigger updated_at (universal)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_proposals_updated') THEN
    CREATE TRIGGER trg_proposals_updated
      BEFORE UPDATE ON proposals
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- ─────────────────────────────────────────────
-- 10. Tabela notification_preferences
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

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_prefs_all" ON notification_preferences;
CREATE POLICY "notif_prefs_all"
  ON notification_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notif_prefs_updated') THEN
    CREATE TRIGGER trg_notif_prefs_updated
      BEFORE UPDATE ON notification_preferences
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- ─────────────────────────────────────────────
-- 11. Tabela email_logs (anti-deduplicação)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  ref_id      UUID,
  status      TEXT NOT NULL DEFAULT 'sent',
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_logs_read" ON email_logs;
CREATE POLICY "email_logs_read"
  ON email_logs FOR SELECT
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- 12. Tabela deletion_requests (LGPD Art. 18)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deletion_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  user_email  TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'delete'
    CHECK (request_type IN ('delete','export','rectify')),
  status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','rejected')),
  protocol    TEXT NOT NULL UNIQUE,
  notes       TEXT,
  processed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deletion_req_insert" ON deletion_requests;
CREATE POLICY "deletion_req_insert"
  ON deletion_requests FOR INSERT
  WITH CHECK (true);
DROP POLICY IF EXISTS "deletion_req_read" ON deletion_requests;
CREATE POLICY "deletion_req_read"
  ON deletion_requests FOR SELECT
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- 13. RLS: policies DELETE em falta
-- ─────────────────────────────────────────────
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

-- RLS proposals: substitui as políticas fragmentadas por policies consolidadas
DROP POLICY IF EXISTS "proposals_read"   ON proposals;
DROP POLICY IF EXISTS "proposals_insert" ON proposals;
DROP POLICY IF EXISTS "proposals_update" ON proposals;
DROP POLICY IF EXISTS "Freelancer can manage own proposals" ON proposals;
DROP POLICY IF EXISTS "Client can read/update proposals for their projects" ON proposals;

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

-- ─────────────────────────────────────────────
-- 14. Função RPC delete_project_cascade
-- ─────────────────────────────────────────────
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

-- ─────────────────────────────────────────────
-- 15. Índices para performance e matching
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_client    ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_category  ON projects(category);
CREATE INDEX IF NOT EXISTS idx_proposals_project  ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_fl       ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status   ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created  ON proposals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_client   ON contracts(client_id);
CREATE INDEX IF NOT EXISTS idx_contracts_fl       ON contracts(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status   ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_messages_contract  ON messages(contract_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_profiles_type      ON profiles(type);
CREATE INDEX IF NOT EXISTS idx_profiles_city      ON profiles(city);
CREATE INDEX IF NOT EXISTS idx_profiles_rate      ON profiles(hourly_rate);
CREATE INDEX IF NOT EXISTS idx_email_logs_user    ON email_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC);

-- ─────────────────────────────────────────────
-- 16. Realtime: habilitar nas tabelas necessárias
--     (pode dar erro se já estiver habilitado — ignore)
-- ─────────────────────────────────────────────
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE proposals;  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE contracts;  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE messages;   EXCEPTION WHEN OTHERS THEN NULL; END;
END$$;

-- ─────────────────────────────────────────────
-- 17. Admin inicial — defina o e-mail do admin
--     Descomente e substitua pelo e-mail correto:
-- ─────────────────────────────────────────────
-- UPDATE profiles SET is_admin = true WHERE email = 'admin@herework.com.br';

-- ═══════════════════════════════════════════════════════════════
-- FIM DA MIGRAÇÃO CONSOLIDADA
-- Execute este script inteiro no SQL Editor do Supabase.
-- ═══════════════════════════════════════════════════════════════
