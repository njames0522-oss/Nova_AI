
/*
  NOVA AI — PUBLIC CONFIGURATION

  Safe to expose:
  - Supabase project URL
  - Supabase publishable key (or legacy anon key)

  NEVER put these here:
  - GROQ_API_KEY
  - OPENROUTER_API_KEY
  - Supabase service_role key
  - Supabase secret key
*/

window.NOVA_CONFIG = {
  SUPABASE_URL: "https://pppzfgynreeqfnprkvse.supabase.co",

  // Replace this with your Supabase publishable key (sb_publishable_...)
  // or your legacy anon key.
  SUPABASE_ANON_KEY: "sb_publishable_XwfsMFdKoKS4N7AqOvIpXA_3U4PPkiF",

  FUNCTIONS_URL: "https://pppzfgynreeqfnprkvse.supabase.co/functions/v1"
};
