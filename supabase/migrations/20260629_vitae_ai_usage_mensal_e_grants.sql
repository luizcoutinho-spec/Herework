-- 20260629_vitae_ai_usage_mensal_e_grants.sql
-- (1) janela diaria -> mensal (1o dia do mes, fuso BR)
-- (2) corrige furo de seguranca: revoga EXECUTE de anon/authenticated/public
-- (3) versiona increment+decrement (antes so existiam no banco)

CREATE OR REPLACE FUNCTION public.increment_ai_usage(p_user uuid, p_limit integer DEFAULT 3)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count INTEGER;
  v_period date := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  INSERT INTO public.ai_import_usage (user_id, day, count)
  VALUES (p_user, v_period, 1)
  ON CONFLICT (user_id, day) DO UPDATE
    SET count = ai_import_usage.count + 1
    WHERE ai_import_usage.count < p_limit
  RETURNING count INTO v_count;
  RETURN v_count IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_ai_usage(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period date := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  UPDATE public.ai_import_usage
  SET    count = GREATEST(0, count - 1)
  WHERE  user_id = p_user
    AND  day     = v_period
    AND  count   > 0;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.increment_ai_usage(uuid, integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.decrement_ai_usage(uuid)          FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION public.increment_ai_usage(uuid, integer) TO service_role;
GRANT  EXECUTE ON FUNCTION public.decrement_ai_usage(uuid)          TO service_role;
