import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve((req) => {
  return new Response(JSON.stringify({ ok: true, msg: "hw-deploy-test alive" }), {
    headers: { "Content-Type": "application/json" },
  });
});
