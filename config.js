// Konfiguration — hier deine eigenen Werte eintragen.
// Anleitung dazu steht in README.md.

const CONFIG = {
  // Google Cloud Console → APIs & Dienste → Anmeldedaten → OAuth-Client-ID (Webanwendung)
  GOOGLE_CLIENT_ID: "18494152203-01ohv2j7lsga7il9huvv7tosqvco7iuq.apps.googleusercontent.com",

  // Aus der URL des Google Sheets: docs.google.com/spreadsheets/d/HIER_STEHT_DIE_ID/edit
  SHEET_ID: "1oz133rU_InyfaYcHi_E7sV6kvH61Ht-XcXAAEnNjvk0",

  // Name des Tabellenblatts (Tab) mit den Aufgaben
  TASKS_SHEET_NAME: "Aufgaben",

  // Google-Kalender-ID für die Kalenderansicht.
  // "primary" nutzt den Kalender des eingeloggten Nutzers.
  // Für einen gemeinsamen Festival-Kalender: die Kalender-ID aus den
  // Google-Kalender-Einstellungen (Format: xxxxx@group.calendar.google.com)
  CALENDAR_ID: "primary",

  // Vorbelegter Wert im "Neue Aufgabe"-Formular für das Festival-Feld
  DEFAULT_FESTIVAL: "ade #19",

  // Anzahl Tage, ab denen eine Aufgabe als "diese Woche" statt "später" gilt
  WEEK_THRESHOLD_DAYS: 7,
};
