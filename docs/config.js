// Shared storage for cases. Leave both empty to keep cases on this computer only.
// The anon key is meant to be public: access is controlled by the sign-in and the row-level
// security rules in supabase/schema.sql.
window.APP_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
};
