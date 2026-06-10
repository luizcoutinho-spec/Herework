-- ═══════════════════════════════════════════════════════════════
--  HereWork — Migração: Módulo de Propostas
--  Execute no Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ═══════════════════════════════════════════════════════════════

-- 1. Enum de status da proposta (se ainda não existir)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'proposal_status') THEN
    CREATE TYPE proposal_status AS ENUM (
      'pending',
      'viewed',
      'shortlisted',
      'accepted',
      'rejected',
      'withdrawn'
    );
  END IF;
END$$;

-- 2. Adicionar coluna `status` à tabela proposals (se ainda não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'proposals' AND column_name = 'status'
  ) THEN
    ALTER TABLE proposals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  END IF;
END$$;

-- 3. Adicionar coluna `updated_at` à tabela proposals (se ainda não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'proposals' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE proposals ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END$$;

-- 4. Tabela notification_preferences (preferências por usuário)
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email_proposals BOOLEAN NOT NULL DEFAULT true,
  email_messages  BOOLEAN NOT NULL DEFAULT true,
  email_contracts BOOLEAN NOT NULL DEFAULT true,
  email_newsletter BOOLEAN NOT NULL DEFAULT false,
  blog_newsletter BOOLEAN NOT NULL DEFAULT false,
  new_projects    BOOLEAN NOT NULL DEFAULT true,
  new_proposals   BOOLEAN NOT NULL DEFAULT true,
  promotions      BOOLEAN NOT NULL DEFAULT false,
  monthly_report  BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 5. Tabela email_logs (anti-deduplicação e auditoria)
CREATE TABLE IF NOT EXISTS email_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  event_type  TEXT NOT NULL,  -- 'proposal_received' | 'proposal_accepted' | etc.
  ref_id      UUID,           -- proposal_id ou contract_id de referência
  status      TEXT NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed' | 'duplicate'
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Índices para performance
CREATE INDEX IF NOT EXISTS idx_proposals_freelancer_id ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_proposals_project_id ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_prefs_user_id ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_user_id ON email_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at DESC);

-- 7. RLS: notification_preferences
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own notification prefs" ON notification_preferences;
CREATE POLICY "Users can manage their own notification prefs"
  ON notification_preferences
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 8. RLS: email_logs (somente leitura pelo próprio usuário)
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own email logs" ON email_logs;
CREATE POLICY "Users can read their own email logs"
  ON email_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- 9. RLS: proposals — garantir que freelancer só vê suas próprias,
--    cliente só vê as de seus projetos
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;

-- Freelancer pode criar e ler/atualizar suas próprias propostas
DROP POLICY IF EXISTS "Freelancer can manage own proposals" ON proposals;
CREATE POLICY "Freelancer can manage own proposals"
  ON proposals
  FOR ALL
  USING (auth.uid() = freelancer_id)
  WITH CHECK (auth.uid() = freelancer_id);

-- Cliente pode ler e atualizar propostas dos seus projetos
DROP POLICY IF EXISTS "Client can read/update proposals for their projects" ON proposals;
CREATE POLICY "Client can read/update proposals for their projects"
  ON proposals
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = proposals.project_id
        AND p.client_id = auth.uid()
    )
  );

-- 10. Trigger: atualizar updated_at automaticamente nas proposals
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS proposals_updated_at ON proposals;
CREATE TRIGGER proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS notif_prefs_updated_at ON notification_preferences;
CREATE TRIGGER notif_prefs_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 11. Habilitar Realtime nas tabelas necessárias
--     (executar uma vez — pode dar erro se já estiver habilitado, ignore)
ALTER PUBLICATION supabase_realtime ADD TABLE proposals;

-- ═══════════════════════════════════════════════════════════════
--  FIM DA MIGRAÇÃO
-- ═══════════════════════════════════════════════════════════════
