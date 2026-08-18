/*
 * Festival Dashboard — Aufgaben + Kalender
 *
 * Sheet-Struktur, die dieses Script erwartet (Tab-Name: siehe config.js TASKS_SHEET_NAME):
 * Zeile 1 = Kopfzeile, danach eine Zeile pro Aufgabe:
 *   A: ID            (eindeutige Zahl oder Kürzel)
 *   B: Titel
 *   C: Projekt
 *   D: Zustaendig_Name   (z.B. "LZ")
 *   E: Zustaendig_Email  (Google-Konto-E-Mail der zuständigen Person)
 *   F: Deadline          (Format: YYYY-MM-DD)
 *   G: Status             ("offen" oder "erledigt")
 */

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

let accessToken = null;
let userEmail = null;
let tasks = [];
let filterMine = true;
let tokenClient = null;

const els = {};

const TOKEN_KEY = "fd_access_token";
const TOKEN_EXPIRY_KEY = "fd_token_expiry";

function saveToken(token, expiresInSeconds) {
  // 60 Sekunden Sicherheitspuffer vor dem echten Ablauf
  const expiryTime = Date.now() + expiresInSeconds * 1000 - 60000;
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(TOKEN_EXPIRY_KEY, String(expiryTime));
}

function loadStoredToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const expiry = sessionStorage.getItem(TOKEN_EXPIRY_KEY);
  if (token && expiry && Date.now() < Number(expiry)) return token;
  return null;
}

function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
}

window.addEventListener("DOMContentLoaded", () => {
  els.loginScreen = document.getElementById("login-screen");
  els.app = document.getElementById("app");
  els.loginBtn = document.getElementById("login-btn");
  els.userLabel = document.getElementById("user-label");
  els.logoutBtn = document.getElementById("logout-btn");
  els.sections = document.getElementById("sections");
  els.status = document.getElementById("status-msg");
  els.btnMine = document.getElementById("filter-mine");
  els.btnAll = document.getElementById("filter-all");
  els.tabTasks = document.getElementById("tab-tasks");
  els.tabCalendar = document.getElementById("tab-calendar");
  els.viewTasks = document.getElementById("view-tasks");
  els.viewCalendar = document.getElementById("view-calendar");
  els.newTaskForm = document.getElementById("new-task-form");
  els.calendarList = document.getElementById("calendar-list");

  els.loginBtn.addEventListener("click", handleLogin);
  els.logoutBtn.addEventListener("click", handleLogout);
  els.btnMine.addEventListener("click", () => setFilter(true));
  els.btnAll.addEventListener("click", () => setFilter(false));
  els.tabTasks.addEventListener("click", () => switchTab("tasks"));
  els.tabCalendar.addEventListener("click", () => switchTab("calendar"));
  els.newTaskForm.addEventListener("submit", handleNewTask);

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: onTokenReceived,
  });

  // 1. Gespeicherten, noch gültigen Token aus diesem Browser-Tab wiederverwenden
  const stored = loadStoredToken();
  if (stored) {
    accessToken = stored;
    enterApp();
    return;
  }

  // 2. Sonst still versuchen, ohne Klick anzumelden (funktioniert nur, wenn
  //    die Google-Sitzung noch aktiv ist und Zugriff bereits erteilt wurde).
  //    Schlägt das fehl, bleibt einfach der normale Login-Bildschirm sichtbar.
  tokenClient.requestAccessToken({ prompt: "" });
});

function handleLogin() {
  // Kein erzwungener "consent"-Prompt mehr: Google zeigt den vollen
  // Berechtigungsdialog nur, wenn er wirklich nötig ist (z.B. beim allerersten
  // Mal oder nach einem Widerruf), sonst geht der Login schneller.
  tokenClient.requestAccessToken({ prompt: "" });
}

function handleLogout() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  userEmail = null;
  clearStoredToken();
  els.app.classList.add("hidden");
  els.loginScreen.classList.remove("hidden");
}

async function onTokenReceived(resp) {
  if (resp.error) {
    // Der stille Auto-Login-Versuch beim Laden der Seite schlägt erwartbar
    // fehl, wenn noch nie eingeloggt wurde oder die Google-Sitzung
    // abgelaufen ist — dann einfach normal den Login-Bildschirm zeigen,
    // ohne rote Fehlermeldung.
    if (resp.error === "interaction_required" || resp.error === "access_denied") {
      return;
    }
    setStatus("Anmeldung fehlgeschlagen: " + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  saveToken(accessToken, resp.expires_in || 3600);
  await enterApp();
}

async function enterApp() {
  els.loginScreen.classList.add("hidden");
  els.app.classList.remove("hidden");
  setStatus("Lade Daten…");

  await fetchUserEmail();
  els.userLabel.textContent = userEmail || "";
  await loadTasks();
  await loadCalendar();
  setStatus("");
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + accessToken,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // Token ist abgelaufen oder wurde extern widerrufen (z.B. auf
    // myaccount.google.com). Gespeicherten Token verwerfen und zurück zum
    // Login-Bildschirm statt eine rote Fehlermeldung zu zeigen.
    clearStoredToken();
    accessToken = null;
    els.app.classList.add("hidden");
    els.loginScreen.classList.remove("hidden");
    throw new Error("Sitzung abgelaufen, bitte erneut anmelden.");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API-Fehler (${res.status}): ${body}`);
  }
  return res.json();
}

async function fetchUserEmail() {
  try {
    const data = await apiFetch("https://www.googleapis.com/oauth2/v3/userinfo");
    userEmail = data.email;
  } catch (e) {
    setStatus("Konnte Nutzer-E-Mail nicht laden.", true);
  }
}

function sheetRange(a1) {
  return `${encodeURIComponent(CONFIG.TASKS_SHEET_NAME)}!${a1}`;
}

async function loadTasks() {
  try {
    const range = sheetRange("A2:G1000");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}`;
    const data = await apiFetch(url);
    const rows = data.values || [];
    tasks = rows
      .filter((r) => r[1])
      .map((r, i) => ({
        rowIndex: i + 2, // echte Zeilennummer im Sheet
        id: r[0] || "",
        title: r[1] || "",
        project: r[2] || "",
        assigneeName: r[3] || "",
        assigneeEmail: (r[4] || "").trim().toLowerCase(),
        due: r[5] || "",
        status: (r[6] || "offen").trim().toLowerCase(),
      }));
    renderTasks();
  } catch (e) {
    setStatus("Konnte Aufgaben nicht laden: " + e.message, true);
  }
}

async function loadCalendar() {
  try {
    const timeMin = new Date().toISOString();
    const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${timeMin}&singleEvents=true&orderBy=startTime&maxResults=15`;
    const data = await apiFetch(url);
    renderCalendar(data.items || []);
  } catch (e) {
    els.calendarList.innerHTML = `<div class="empty">Kalender konnte nicht geladen werden: ${e.message}</div>`;
  }
}

function urgencyOf(dueStr) {
  if (!dueStr) return "later";
  const due = new Date(dueStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= (CONFIG.WEEK_THRESHOLD_DAYS ?? 7)) return "week";
  return "later";
}

function formatDue(dueStr, urgency) {
  if (!dueStr) return "—";
  const due = new Date(dueStr + "T00:00:00");
  const label = due.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  if (urgency === "overdue") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today - due) / 86400000);
    return `vor ${days} Tag${days === 1 ? "" : "en"}`;
  }
  return label;
}

function setFilter(mine) {
  filterMine = mine;
  els.btnMine.classList.toggle("active", mine);
  els.btnAll.classList.toggle("active", !mine);
  renderTasks();
}

function switchTab(tab) {
  els.tabTasks.classList.toggle("active", tab === "tasks");
  els.tabCalendar.classList.toggle("active", tab === "calendar");
  els.viewTasks.classList.toggle("hidden", tab !== "tasks");
  els.viewCalendar.classList.toggle("hidden", tab !== "calendar");
}

function renderTasks() {
  const visible = tasks.filter((t) => !filterMine || t.assigneeEmail === (userEmail || "").toLowerCase());
  const openTasks = visible.filter((t) => t.status !== "erledigt");
  const doneTasks = visible.filter((t) => t.status === "erledigt");

  const groups = [
    { key: "overdue", label: "Überfällig", cls: "overdue" },
    { key: "week", label: "Diese Woche", cls: "week" },
    { key: "later", label: "Später", cls: "later" },
  ];

  let html = "";
  groups.forEach((g) => {
    const items = openTasks.filter((t) => urgencyOf(t.due) === g.key);
    if (items.length === 0) return;
    html += `<div class="group">
      <div class="group-label ${g.cls}">${g.label} <span class="count">${items.length}</span></div>
      ${items.map(taskHtml).join("")}
    </div>`;
  });

  if (openTasks.length === 0) {
    html = `<div class="empty">Keine offenen Aufgaben.</div>` + html;
  }

  if (doneTasks.length > 0) {
    html += `<details>
      <summary>Erledigt (${doneTasks.length})</summary>
      ${doneTasks.map(taskHtml).join("")}
    </details>`;
  }

  els.sections.innerHTML = html;

  els.sections.querySelectorAll(".task-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const rowIndex = parseInt(e.target.dataset.row, 10);
      updateTaskStatus(rowIndex, e.target.checked);
    });
  });
}

function taskHtml(t) {
  const urgency = t.status === "erledigt" ? "done" : urgencyOf(t.due);
  const dueLabel = t.status === "erledigt" ? "erledigt" : formatDue(t.due, urgency);
  return `
  <div class="task">
    <input type="checkbox" class="task-check" data-row="${t.rowIndex}" ${t.status === "erledigt" ? "checked" : ""} />
    <div class="task-body">
      <div class="task-title ${t.status === "erledigt" ? "done" : ""}">${escapeHtml(t.title)}</div>
      <div class="task-project">${escapeHtml(t.project)}</div>
    </div>
    <div class="task-due ${urgency}">${dueLabel}</div>
    <div class="avatar" title="${escapeHtml(t.assigneeName)}">${escapeHtml(t.assigneeName).slice(0, 2).toUpperCase()}</div>
  </div>`;
}

async function updateTaskStatus(rowIndex, done) {
  const range = sheetRange(`G${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[done ? "erledigt" : "offen"]] }),
    });
    const t = tasks.find((x) => x.rowIndex === rowIndex);
    if (t) t.status = done ? "erledigt" : "offen";
    renderTasks();
  } catch (e) {
    setStatus("Status konnte nicht gespeichert werden: " + e.message, true);
  }
}

async function handleNewTask(e) {
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  const project = form.project.value.trim();
  const assigneeName = form.assigneeName.value.trim();
  const assigneeEmail = form.assigneeEmail.value.trim();
  const due = form.due.value;

  if (!title || !due) {
    setStatus("Titel und Deadline sind Pflichtfelder.", true);
    return;
  }

  const newId = String(Date.now()).slice(-6);
  const range = sheetRange("A2:G2");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${sheetRange("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  try {
    await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: [[newId, title, project, assigneeName, assigneeEmail, due, "offen"]],
      }),
    });
    form.reset();
    setStatus("Aufgabe hinzugefügt.");
    await loadTasks();
  } catch (e) {
    setStatus("Aufgabe konnte nicht angelegt werden: " + e.message, true);
  }
}

function renderCalendar(events) {
  if (events.length === 0) {
    els.calendarList.innerHTML = `<div class="empty">Keine anstehenden Termine.</div>`;
    return;
  }
  els.calendarList.innerHTML = events
    .map((ev) => {
      const start = ev.start.dateTime || ev.start.date;
      const d = new Date(start);
      const dateLabel = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
      const timeLabel = ev.start.dateTime
        ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
        : "ganztägig";
      return `<div class="event">
        <div class="event-date">${dateLabel}<br>${timeLabel}</div>
        <div class="event-title">${escapeHtml(ev.summary || "(ohne Titel)")}</div>
      </div>`;
    })
    .join("");
}

function setStatus(msg, isError) {
  els.status.textContent = msg;
  els.status.style.color = isError ? "var(--danger)" : "var(--text-secondary)";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
