/**
 * Offentlig konfigurasjon for butikkpanelet.
 *
 * anon-nøkkelen er ment å ligge i nettleseren. Den gir ingen tilgang i seg selv:
 * radene er beskyttet av RLS, og butikken ser bare sine egne tilbud fordi
 * store_users kobler den innloggede brukeren til én butikk (se 004_store_panel.sql).
 *
 * Bytt disse to verdiene til deres eget prosjekt hvis dere flytter panelet.
 */
window.GARNLY_CONFIG = {
  SUPABASE_URL: "https://zesaeleooiptrpjzqhxe.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inplc2FlbGVvb2lwdHJwanpxaHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MjIzOTcsImV4cCI6MjEwMzM5ODM5N30.WrblLlSQvxk3wtvgghBz3NHLo0vO8gr_s3f_HRPnEhg",
  // Hvor ofte panelet henter på nytt selv om sanntid skulle falle ut (millisekunder)
  POLL_MS: 30000,
  // Butikkhandtaket i Shopify-admin. Brukes bare til å lenke dit fra Garnly-fanen, så en
  // eskalert ordre kan kanselleres og refunderes av et menneske.
  SHOPIFY_STORE: "fhxr10-gu",
};
