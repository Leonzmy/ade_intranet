// Konfiguration — hier deine eigenen Werte eintragen.
// Anleitung dazu steht in README.md.

const CONFIG = {
  // Google Cloud Console → APIs & Dienste → Anmeldedaten → OAuth-Client-ID (Webanwendung)
  GOOGLE_CLIENT_ID: "DEINE_CLIENT_ID.apps.googleusercontent.com",

  // Aus der URL des Google Sheets: docs.google.com/spreadsheets/d/HIER_STEHT_DIE_ID/edit
  SHEET_ID: "DEINE_SHEET_ID",

  // Name des Tabellenblatts (Tab) mit den Aufgaben
  TASKS_SHEET_NAME: "Aufgaben",

  // Google-Kalender-ID für die Kalenderansicht.
  // "primary" nutzt den Kalender des eingeloggten Nutzers.
  // Für einen gemeinsamen Festival-Kalender: die Kalender-ID aus den
  // Google-Kalender-Einstellungen (Format: xxxxx@group.calendar.google.com)
  CALENDAR_ID: "primary",

  // Anzahl Tage, ab denen eine Aufgabe als "diese Woche" statt "später" gilt
  WEEK_THRESHOLD_DAYS: 7,
};
