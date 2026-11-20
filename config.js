/*
  PUBLIC browser configuration only.
  Safe: Supabase project URL + publishable key (or legacy anon key) with RLS enabled.
  NEVER put OpenAI/Groq/Gemini keys, Supabase secret keys, or service_role keys here.
*/
window.NOVA_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  FUNCTIONS_URL: "https://YOUR_PROJECT_REF.supabase.co/functions/v1"
};
