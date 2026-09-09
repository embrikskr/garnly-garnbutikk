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
  SUPABASE_ANON_KEY: "SETT_INN_ANON_KEY",
  // Hvor ofte panelet henter på nytt selv om sanntid skulle falle ut (millisekunder)
  POLL_MS: 30000,
};
