// Konfiguration — hier deine eigenen Werte eintragen.
// Anleitung dazu steht in README.md.

const CONFIG = {
  // Google Cloud Console → APIs & Dienste → Anmeldedaten → OAuth-Client-ID (Webanwendung)
  GOOGLE_CLIENT_ID: "18494152203-egf4o2cir3ou4mfof13hdhbudhp2sp65.apps.googleusercontent.com",
 

  // Aus der URL des Google Sheets: docs.google.com/spreadsheets/d/HIER_STEHT_DIE_ID/edit
  SHEET_ID: "1oz133rU_InyfaYcHi_E7sV6kvH61Ht-XcXAAEnNjvk0",

  // Name des Tabellenblatts (Tab) mit den Aufgaben
  TASKS_SHEET_NAME: "Aufgaben",

  // Name des Tabellenblatts mit Personen/Projekten/Festival-Editionen
  STAMMDATEN_SHEET_NAME: "Stammdaten",

   // Name des Tabellenblatts mit dem Event-Vorbereitungsstatus
  EVENTS_SHEET_NAME: "Events",
  
  // Name der Tabellenblätter für Technik-Inventar und Buchungen
  INVENTORY_SHEET_NAME: "Inventar",
  BOOKINGS_SHEET_NAME: "Buchungen",

   // Name des Tabellenblatts für Kontakte (Ensemble/Interpret:innen/Komponist:innen)
  CONTACTS_SHEET_NAME: "Kontakte",

    // URL, unter der kontakt-formular.html erreichbar ist (z.B. auf GitHub
  // Pages neben index.html), OHNE Fragezeichen/Parameter am Ende
  PUBLIC_FORM_URL: "https://leonzmy.github.io/ade_intranet/kontakt-formular.html",

    // Dieselbe Apps-Script-Web-App-URL wie in kontakt-formular.html (WEBAPP_URL)
  WEBAPP_URL: "https://script.google.com/macros/s/AKfycbzYq3uojflMADX03NrX3e4_4DeB5c48o1mXHzGwSiGv88g0vuJ_bhrySTm_nkqNZ5UlLQ/exec",

    // Feste Vertragsvorlagen (nicht im Frontend änderbar)
  CONTRACT_TEMPLATES: {
    "Ensemble": "https://docs.google.com/document/d/1Cbh_-Mp9tjHaa6z7RK-F2Q223C-Tc-KL-LHNDJBbOEo/edit",
    "Interpret:in": "https://docs.google.com/document/d/1OCpiXZPOMeM4-ZmBP89Oc4j-8NL6o8kKQWv557d82Dw/edit",
    "Komponist:in": "https://docs.google.com/document/d/1F_C8Xs1CQQhqF4z1-sdDGLNw3H4kMJ8tLtnDy7mL1QM/edit",
  },
   
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
