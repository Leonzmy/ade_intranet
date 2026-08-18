/*
 * Festival Dashboard — Aufgaben + Kalender
 *
 * Sheet-Struktur (Tab-Name: siehe config.js TASKS_SHEET_NAME):
 * Zeile 1 = Kopfzeile, danach eine Zeile pro Aufgabe:
 *   A: ID
 *   B: Titel
 *   C: Projekt
 *   D: Festival
 *   E: Zustaendig_Name
 *   F: Zustaendig_Kuerzel   (im Sheet per Formel aus Stammdaten nachgeschlagen)
 *   G: Zustaendig_Email     (im Sheet per Formel aus Stammdaten nachgeschlagen)
 *   H: Deadline              (Format: YYYY-MM-DD)
 *   I: Status                 ("offen" oder "erledigt")
 *   J: Notizen                (Verlauf, ein Eintrag pro Zeile: ISO-Zeit|Autor|Text)
 */

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

let accessToken = null;
let userEmail = null;
let tasks = [];
let filterMine = true;
let tokenClient = null;
let expandedRow = null;
let peopleList = [];    // [{name, kuerzel, email}]
let projectList = [];   // ["Marketing", ...]
let festivalList = [];  // ["ade #19", ...]
let calViewMode = "month"; // "month" | "week"
let calAnchor = new Date(); // Referenzdatum für aktuelle Ansicht

const els = {};

const TOKEN_KEY = "fd_access_token";
const TOKEN_EXPIRY_KEY = "fd_token_expiry";

function saveToken(token, expiresInSeconds) {
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
  els.projectSelect = document.getElementById("project-select");
  els.festivalSelect = document.getElementById("festival-select");
  els.assigneeSelect = document.getElementById("assignee-select");
  els.calGrid = document.getElementById("calendar-grid");
  els.calLabel = document.getElementById("cal-label");
  els.calPrev = document.getElementById("cal-prev");
  els.calNext = document.getElementById("cal-next");
  els.calToday = document.getElementById("cal-today");
  els.calViewMonth = document.getElementById("cal-view-month");
  els.calViewWeek = document.getElementById("cal-view-week");
  els.calNewEventBtn = document.getElementById("cal-new-event-btn");
  els.newEventForm = document.getElementById("new-event-form");

  els.calPrev.addEventListener("click", () => shiftCalendar(-1));
  els.calNext.addEventListener("click", () => shiftCalendar(1));
  els.calToday.addEventListener("click", () => { calAnchor = new Date(); loadCalendar(); });
  els.calViewMonth.addEventListener("click", () => setCalView("month"));
  els.calViewWeek.addEventListener("click", () => setCalView("week"));
  els.calNewEventBtn.addEventListener("click", () => els.newEventForm.classList.toggle("hidden"));
  els.newEventForm.addEventListener("submit", handleNewEvent);

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

  const stored = loadStoredToken();
  if (stored) {
    accessToken = stored;
    enterApp();
    return;
  }

  // Kein automatischer Login-Versuch mehr beim Laden — Browser blockieren
  // Popups grundsätzlich, wenn sie nicht direkt aus einem Klick ausgelöst
  // werden. Der Login-Bildschirm mit dem Button bleibt einfach sichtbar.
});

function handleLogin() {
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
  await loadStammdaten();
  await loadTasks();
  await syncDeadlinesToCalendar();
  await loadCalendar();
  setStatus("");
}

async function loadStammdaten() {
  try {
    const sheet = encodeURIComponent(CONFIG.STAMMDATEN_SHEET_NAME);
    const ranges = [
      `${sheet}!A2:C50`,
      `${sheet}!E2:E50`,
      `${sheet}!G2:G50`,
    ].map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchGet?${ranges}`;
    const data = await apiFetch(url);
    const [peopleRes, projectRes, festivalRes] = data.valueRanges || [];

    peopleList = (peopleRes?.values || [])
      .filter((r) => r[0])
      .map((r) => ({ name: r[0], kuerzel: r[1] || "", email: (r[2] || "").trim().toLowerCase() }));

    projectList = (projectRes?.values || []).map((r) => r[0]).filter(Boolean);
    festivalList = (festivalRes?.values || []).map((r) => r[0]).filter(Boolean);

    fillSelect(els.projectSelect, projectList);
    fillSelect(els.festivalSelect, festivalList, CONFIG.DEFAULT_FESTIVAL);
    fillSelect(els.assigneeSelect, peopleList.map((p) => p.name));
  } catch (e) {
    setStatus("Stammdaten (Personen/Projekte) konnten nicht geladen werden: " + e.message, true);
  }
}

function fillSelect(selectEl, values, defaultValue) {
  const placeholder = selectEl.options[0];
  selectEl.innerHTML = "";
  selectEl.appendChild(placeholder);
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    if (defaultValue && v === defaultValue) opt.selected = true;
    selectEl.appendChild(opt);
  });
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
    const range = sheetRange("A2:J1000");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}`;
    const data = await apiFetch(url);
    const rows = data.values || [];
    tasks = rows
      .filter((r) => r[1])
      .map((r, i) => ({
        rowIndex: i + 2,
        id: r[0] || "",
        title: r[1] || "",
        project: r[2] || "",
        festival: r[3] || "",
        assigneeName: r[4] || "",
        assigneeKuerzel: r[5] || "",
        assigneeEmail: (r[6] || "").trim().toLowerCase(),
        due: r[7] || "",
        status: (r[8] || "offen").trim().toLowerCase(),
        notesRaw: r[9] || "",
      }));
    renderTasks();
  } catch (e) {
    setStatus("Konnte Aufgaben nicht laden: " + e.message, true);
  }
}

// ---------- Deadline-Synchronisation ----------

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function syncDeadlinesToCalendar() {
  try {
    const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
    const listUrl = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?privateExtendedProperty=fdSource%3Ddeadline&maxResults=250&singleEvents=true`;
    const data = await apiFetch(listUrl);
    const existingByTaskId = {};
    (data.items || []).forEach((ev) => {
      const tid = ev.extendedProperties?.private?.fdTaskId;
      if (tid) existingByTaskId[tid] = ev;
    });

    for (const t of tasks) {
      const existing = existingByTaskId[t.id];
      const isDone = t.status === "erledigt";

      if (!t.due || isDone) {
        if (existing) {
          await apiFetch(
            `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${existing.id}`,
            { method: "DELETE" }
          );
        }
        if (existing) delete existingByTaskId[t.id];
        continue;
      }

      const desiredSummary = `⏰ ${t.title}`;
      const desiredStart = t.due;
      const desiredEnd = addDaysStr(t.due, 1);

      if (!existing) {
        await apiFetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: desiredSummary,
            start: { date: desiredStart },
            end: { date: desiredEnd },
            extendedProperties: { private: { fdSource: "deadline", fdTaskId: String(t.id) } },
          }),
        });
      } else {
        const changed = existing.summary !== desiredSummary || existing.start?.date !== desiredStart;
        if (changed) {
          await apiFetch(
            `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${existing.id}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: desiredSummary,
                start: { date: desiredStart },
                end: { date: desiredEnd },
              }),
            }
          );
        }
        delete existingByTaskId[t.id];
      }
    }

    // Übrig gebliebene Deadline-Events gehören zu Aufgaben, die es nicht mehr gibt
    for (const tid of Object.keys(existingByTaskId)) {
      await apiFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${existingByTaskId[tid].id}`,
        { method: "DELETE" }
      );
    }
  } catch (e) {
    setStatus("Deadlines konnten nicht mit dem Kalender synchronisiert werden: " + e.message, true);
  }
}

// ---------- Kalenderansicht ----------

function startOfWeek(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Montag = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isSameDay(a, b) {
  return dateKey(a) === dateKey(b);
}

function eventDateKey(ev) {
  const raw = ev.start.date || ev.start.dateTime;
  return raw.slice(0, 10);
}

function isDeadlineEvent(ev) {
  return ev.extendedProperties?.private?.fdSource === "deadline";
}

function setCalView(mode) {
  calViewMode = mode;
  els.calViewMonth.classList.toggle("active", mode === "month");
  els.calViewWeek.classList.toggle("active", mode === "week");
  loadCalendar();
}

function shiftCalendar(dir) {
  if (calViewMode === "month") {
    calAnchor = new Date(calAnchor.getFullYear(), calAnchor.getMonth() + dir, 1);
  } else {
    calAnchor = addDays(calAnchor, dir * 7);
  }
  loadCalendar();
}

async function loadCalendar() {
  const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
  let rangeStart, rangeEnd;

  if (calViewMode === "month") {
    const firstOfMonth = new Date(calAnchor.getFullYear(), calAnchor.getMonth(), 1);
    rangeStart = startOfWeek(firstOfMonth);
    rangeEnd = addDays(rangeStart, 42);
    els.calLabel.textContent = calAnchor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  } else {
    rangeStart = startOfWeek(calAnchor);
    rangeEnd = addDays(rangeStart, 7);
    const rangeEndLabel = addDays(rangeStart, 6);
    els.calLabel.textContent =
      rangeStart.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) +
      " – " +
      rangeEndLabel.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${rangeStart.toISOString()}&timeMax=${rangeEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250`;
    const data = await apiFetch(url);
    const events = data.items || [];
    if (calViewMode === "month") {
      renderMonthGrid(rangeStart, events);
    } else {
      renderWeekGrid(rangeStart, events);
    }
  } catch (e) {
    els.calGrid.innerHTML = `<div class="empty">Kalender konnte nicht geladen werden: ${e.message}</div>`;
  }
}

function renderMonthGrid(gridStart, events) {
  const eventsByDay = {};
  events.forEach((ev) => {
    const key = eventDateKey(ev);
    (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });

  const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const today = new Date();
  const currentMonth = calAnchor.getMonth();

  let html = weekdayLabels.map((l) => `<div class="cal-weekday-label">${l}</div>`).join("");

  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const key = dateKey(day);
    const dayEvents = eventsByDay[key] || [];
    const outside = day.getMonth() !== currentMonth;
    const isToday = isSameDay(day, today);

    const shown = dayEvents.slice(0, 3);
    const extra = dayEvents.length - shown.length;

    const chips = shown
      .map((ev) => {
        const cls = isDeadlineEvent(ev) ? "" : "is-event";
        return `<div class="cal-chip ${cls}" title="${escapeHtml(ev.summary || "")}">${escapeHtml(ev.summary || "(ohne Titel)")}</div>`;
      })
      .join("");
    const more = extra > 0 ? `<div class="cal-chip-more">+${extra} mehr</div>` : "";

    html += `<div class="cal-day ${outside ? "outside" : ""} ${isToday ? "today" : ""}">
      <div class="cal-day-num">${day.getDate()}</div>
      ${chips}${more}
    </div>`;
  }

  els.calGrid.innerHTML = `<div class="cal-month-grid">${html}</div>`;
}

function renderWeekGrid(weekStart, events) {
  const eventsByDay = {};
  events.forEach((ev) => {
    const key = eventDateKey(ev);
    (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });

  const today = new Date();
  let html = "";

  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const key = dateKey(day);
    const dayEvents = (eventsByDay[key] || []).sort((a, b) =>
      (a.start.dateTime || a.start.date).localeCompare(b.start.dateTime || b.start.date)
    );
    const isToday = isSameDay(day, today);
    const label = day.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });

    const items = dayEvents
      .map((ev) => {
        const isDeadline = isDeadlineEvent(ev);
        const time = ev.start.dateTime
          ? new Date(ev.start.dateTime).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
          : "ganztägig";
        return `<div class="cal-week-event ${isDeadline ? "is-deadline" : ""}">
          <span class="cal-week-event-time">${time}</span>
          ${escapeHtml(ev.summary || "(ohne Titel)")}
        </div>`;
      })
      .join("");

    html += `<div class="cal-week-day ${isToday ? "today" : ""}">
      <div class="cal-week-day-header">${label}</div>
      ${items || '<div class="notes-empty">Keine Termine.</div>'}
    </div>`;
  }

  els.calGrid.innerHTML = `<div class="cal-week-grid">${html}</div>`;
}

async function handleNewEvent(e) {
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  const date = form.date.value;
  const time = form.time.value;

  if (!title || !date) {
    setStatus("Titel und Datum sind Pflichtfelder für einen Termin.", true);
    return;
  }

  const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
  let body;
  if (time) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const startDateTime = `${date}T${time}:00`;
    const [h, m] = time.split(":").map(Number);
    const endDate = new Date(`${date}T${time}:00`);
    endDate.setHours(endDate.getHours() + 1);
    const endDateTime = endDate.toISOString().slice(0, 19);
    body = {
      summary: title,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
    };
  } else {
    body = {
      summary: title,
      start: { date: date },
      end: { date: addDaysStr(date, 1) },
    };
  }

  try {
    await apiFetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    form.reset();
    els.newEventForm.classList.add("hidden");
    setStatus("Termin gespeichert.");
    await loadCalendar();
  } catch (e) {
    setStatus("Termin konnte nicht gespeichert werden: " + e.message, true);
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

  els.sections.querySelectorAll(".task-main").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".task-check")) return;
      const rowIndex = parseInt(row.dataset.row, 10);
      toggleNotes(rowIndex);
    });
  });

  els.sections.querySelectorAll(".notes-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const rowIndex = parseInt(form.dataset.row, 10);
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      addNote(rowIndex, text);
      input.value = "";
    });
  });
}

function parseNotes(raw) {
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      if (parts.length >= 3) {
        return { ts: parts[0], author: parts[1], text: parts.slice(2).join("|") };
      }
      return { ts: "", author: "", text: line };
    });
}

function formatNoteTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function taskHtml(t) {
  const urgency = t.status === "erledigt" ? "done" : urgencyOf(t.due);
  const dueLabel = t.status === "erledigt" ? "erledigt" : formatDue(t.due, urgency);
  const isOpen = expandedRow === t.rowIndex;
  const notes = parseNotes(t.notesRaw);
  const noteCount = notes.length;

  const notesListHtml = notes.length
    ? notes.map((n) => `
        <div class="note-bubble">
          <div class="note-meta">${escapeHtml(n.author.split("@")[0] || "?")} · ${formatNoteTime(n.ts)}</div>
          <div class="note-text">${escapeHtml(n.text)}</div>
        </div>`).join("")
    : `<div class="notes-empty">Noch keine Notizen.</div>`;

  return `
  <div class="task-wrap">
    <div class="task task-main" data-row="${t.rowIndex}">
      <input type="checkbox" class="task-check" data-row="${t.rowIndex}" ${t.status === "erledigt" ? "checked" : ""} />
      <div class="task-body">
        <div class="task-title ${t.status === "erledigt" ? "done" : ""}">${escapeHtml(t.title)}</div>
        <div class="task-project">${escapeHtml(t.project)}${t.festival ? " · " + escapeHtml(t.festival) : ""}</div>
      </div>
      <div class="note-indicator">${noteCount > 0 ? `<i class="ti ti-message-circle"></i> ${noteCount}` : ""}</div>
      <div class="task-due ${urgency}">${dueLabel}</div>
      <div class="avatar" title="${escapeHtml(t.assigneeName)}">${escapeHtml((t.assigneeKuerzel || t.assigneeName).slice(0, 2)).toUpperCase()}</div>
    </div>
    <div class="notes-panel ${isOpen ? "" : "hidden"}" data-row-panel="${t.rowIndex}">
      <div class="notes-list">${notesListHtml}</div>
      <form class="notes-form" data-row="${t.rowIndex}">
        <input type="text" placeholder="Notiz hinzufügen…" />
        <button type="submit" class="btn primary">Senden</button>
      </form>
    </div>
  </div>`;
}

function toggleNotes(rowIndex) {
  expandedRow = expandedRow === rowIndex ? null : rowIndex;
  renderTasks();
}

async function updateTaskStatus(rowIndex, done) {
  const range = sheetRange(`I${rowIndex}`);
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

function buildNoteLine(author, text) {
  const safeText = text.trim().replace(/\|/g, "/").replace(/\n/g, " ");
  return `${new Date().toISOString()}|${author}|${safeText}`;
}

async function addNote(rowIndex, text) {
  const t = tasks.find((x) => x.rowIndex === rowIndex);
  if (!t) return;
  const author = userEmail || "unbekannt";
  const line = buildNoteLine(author, text);
  const newRaw = t.notesRaw ? t.notesRaw + "\n" + line : line;

  const range = sheetRange(`J${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[newRaw]] }),
    });
    t.notesRaw = newRaw;
    renderTasks();
  } catch (e) {
    setStatus("Notiz konnte nicht gespeichert werden: " + e.message, true);
  }
}

async function handleNewTask(e) {
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  const project = form.project.value.trim();
  const festival = (form.festival.value || CONFIG.DEFAULT_FESTIVAL || "").trim();
  const assigneeName = form.assigneeName.value.trim();
  const due = form.due.value;
  const initialNote = form.notes.value.trim();

  if (!title || !due) {
    setStatus("Titel und Deadline sind Pflichtfelder.", true);
    return;
  }

  const newId = String(Date.now()).slice(-6);
  const notesValue = initialNote ? buildNoteLine(userEmail || "unbekannt", initialNote) : "";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${sheetRange("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  try {
    const appendResp = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: [[newId, title, project, festival, assigneeName, "", "", due, "offen", notesValue]],
      }),
    });

    // Kürzel/Email nachträglich als Formel setzen (zuverlässiger als
    // clientseitige Namens-Zuordnung, funktioniert genau wie im Sheet selbst)
    const updatedRange = appendResp?.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/![A-Z]+(\d+)/);
    const newRowIndex = rowMatch ? parseInt(rowMatch[1], 10) : null;
    if (newRowIndex) {
      const kuerzelFormula = `=IFERROR(INDEX(Stammdaten!$B$2:$B$50,MATCH(TRIM(E${newRowIndex}),Stammdaten!$A$2:$A$50,0))&"","")`;
      const emailFormula = `=IFERROR(INDEX(Stammdaten!$C$2:$C$50,MATCH(TRIM(E${newRowIndex}),Stammdaten!$A$2:$A$50,0))&"","")`;
      const formulaRange = sheetRange(`F${newRowIndex}:G${newRowIndex}`);
      const formulaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${formulaRange}?valueInputOption=USER_ENTERED`;
      await apiFetch(formulaUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[kuerzelFormula, emailFormula]] }),
      });
    }
    form.reset();
    setStatus("Aufgabe hinzugefügt.");
    await loadTasks();
  } catch (e) {
    setStatus("Aufgabe konnte nicht angelegt werden: " + e.message, true);
  }
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
