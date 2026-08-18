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
let lastCalendarEvents = [];

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

function bindClick(el, handler) {
  if (el) el.addEventListener("click", handler);
}

function bindSubmit(el, handler) {
  if (el) el.addEventListener("submit", handler);
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
  els.navItems = document.querySelectorAll(".nav-item");
  els.views = document.querySelectorAll(".view");
  els.dashboardStats = document.getElementById("dashboard-stats");
  els.dashboardUpcoming = document.getElementById("dashboard-upcoming");
  els.newTaskForm = document.getElementById("new-task-form");
  els.newNeedForm = document.getElementById("new-need-form");
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
  els.riderModal = document.getElementById("rider-modal");
  els.riderModalClose = document.getElementById("rider-modal-close");
  els.riderDoneCheckbox = document.getElementById("rider-done-checkbox");
  els.riderCsvBtn = document.getElementById("rider-csv-btn");

  bindClick(els.calPrev, () => shiftCalendar(-1));
  bindClick(els.calNext, () => shiftCalendar(1));
  bindClick(els.calToday, () => { calAnchor = new Date(); loadCalendar(); });
  bindClick(els.calViewMonth, () => setCalView("month"));
  bindClick(els.calViewWeek, () => setCalView("week"));
  bindClick(els.calNewEventBtn, () => els.newEventForm && els.newEventForm.classList.toggle("hidden"));
  bindSubmit(els.newEventForm, handleNewEvent);
  bindClick(els.riderModalClose, closeRiderModal);
  bindClick(els.riderCsvBtn, downloadRiderCsv);
  if (els.riderDoneCheckbox) els.riderDoneCheckbox.addEventListener("change", (e) => setRiderDone(e.target.checked));
  if (els.riderModal) {
    els.riderModal.addEventListener("click", (e) => {
      if (e.target === els.riderModal) closeRiderModal();
    });
  }

  bindClick(els.loginBtn, handleLogin);
  bindClick(els.logoutBtn, handleLogout);
  bindClick(els.btnMine, () => setFilter(true));
  bindClick(els.btnAll, () => setFilter(false));
  els.navItems.forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  const dashCalCard = document.getElementById("dashboard-calendar-card");
  if (dashCalCard) dashCalCard.addEventListener("click", () => switchView("calendar"));
  bindSubmit(els.newTaskForm, handleNewTask);
  bindSubmit(els.newNeedForm, handleNewNeed);

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
  await loadEvents();
  await loadInventory();
  await syncRiderStatuses();
  await syncDeadlinesToCalendar();
  await loadCalendar();
  renderDashboard();
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
    lastCalendarEvents = events.filter((ev) => {
      const raw = ev.start.dateTime || ev.start.date;
      return new Date(raw) >= new Date(new Date().toDateString());
    });
    if (calViewMode === "month") {
      renderMonthGrid(rangeStart, events);
    } else {
      renderWeekGrid(rangeStart, events);
    }
  } catch (e) {
    els.calGrid.innerHTML = `<div class="empty">Kalender konnte nicht geladen werden: ${e.message}</div>`;
  }
}

function renderMonthGrid(gridStart, events, targetEl, maxChips) {
  targetEl = targetEl || els.calGrid;
  maxChips = maxChips || 3;
  const referenceMonth = targetEl === els.calGrid ? calAnchor.getMonth() : new Date().getMonth();

  const eventsByDay = {};
  events.forEach((ev) => {
    const key = eventDateKey(ev);
    (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });

  const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const today = new Date();

  let html = weekdayLabels.map((l) => `<div class="cal-weekday-label">${l}</div>`).join("");

  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const key = dateKey(day);
    const dayEvents = eventsByDay[key] || [];
    const outside = day.getMonth() !== referenceMonth;
    const isToday = isSameDay(day, today);

    const shown = dayEvents.slice(0, maxChips);
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

  const gridClass = targetEl === els.calGrid ? "cal-month-grid" : "cal-month-grid mini";
  targetEl.innerHTML = `<div class="${gridClass}">${html}</div>`;
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

function switchView(view) {
  els.navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  els.views.forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
  if (view === "dashboard") renderDashboard();
  if (view === "events") renderEvents();
  if (view === "inventory") renderInventory();
}

function renderDashboard() {
  const mine = tasks.filter((t) => t.assigneeEmail === (userEmail || "").toLowerCase());
  const open = mine.filter((t) => t.status !== "erledigt");
  const overdue = open.filter((t) => urgencyOf(t.due) === "overdue").length;
  const week = open.filter((t) => urgencyOf(t.due) === "week").length;
  const later = open.filter((t) => urgencyOf(t.due) === "later").length;

  els.dashboardStats.innerHTML = `
    <div class="dashboard-stat overdue"><div class="num">${overdue}</div><div class="label">Überfällig</div></div>
    <div class="dashboard-stat week"><div class="num">${week}</div><div class="label">Diese Woche</div></div>
    <div class="dashboard-stat"><div class="num">${later}</div><div class="label">Später</div></div>
  `;

  const urgencyRank = { overdue: 0, week: 1, later: 2 };
  const sorted = [...open].sort((a, b) => {
    const ua = urgencyRank[urgencyOf(a.due)];
    const ub = urgencyRank[urgencyOf(b.due)];
    if (ua !== ub) return ua - ub;
    return (a.due || "").localeCompare(b.due || "");
  });
  const top = sorted.slice(0, 6);

  els.dashboardTasksList = els.dashboardTasksList || document.getElementById("dashboard-tasks-list");
  els.dashboardTasksList.innerHTML = top.length
    ? top
        .map((t) => {
          const urgency = urgencyOf(t.due);
          const dueLabel = formatDue(t.due, urgency);
          return `<div class="dashboard-task-row" data-row="${t.rowIndex}">
            <div>
              <div class="title">${escapeHtml(t.title)}</div>
              <div class="project">${escapeHtml(t.project)}</div>
            </div>
            <div class="task-due ${urgency}">${dueLabel}</div>
          </div>`;
        })
        .join("")
    : `<div class="empty">Keine offenen Aufgaben — alles erledigt.</div>`;

  els.dashboardTasksList.querySelectorAll(".dashboard-task-row").forEach((row) => {
    row.addEventListener("click", () => switchView("tasks"));
  });

  renderDashboardCalendar();
}

async function renderDashboardCalendar() {
  const target = document.getElementById("dashboard-mini-calendar");
  if (!target) return;
  const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const rangeStart = startOfWeek(firstOfMonth);
  const rangeEnd = addDays(rangeStart, 42);
  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${rangeStart.toISOString()}&timeMax=${rangeEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250`;
    const data = await apiFetch(url);
    renderMonthGrid(rangeStart, data.items || [], target, 2);
  } catch (e) {
    target.innerHTML = `<div class="empty">Kalender konnte nicht geladen werden.</div>`;
  }
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

async function createTaskRow({ title, project, festival, assigneeName, due, initialNote }) {
  const newId = String(Date.now()).slice(-6);
  const notesValue = initialNote ? buildNoteLine(userEmail || "unbekannt", initialNote) : "";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${sheetRange("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const appendResp = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      values: [[newId, title, project, festival, assigneeName, "", "", due, "offen", notesValue]],
    }),
  });

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
  return newRowIndex;
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

  try {
    await createTaskRow({ title, project, festival, assigneeName, due, initialNote });
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

// ---------- Rider-Status & Modal ----------

function riderStatusFor(ev) {
  const stored = ev.items.rider.status;
  if (stored === "vorhanden") return "vorhanden";
  const hasBookings = bookings.some((b) => b.project === ev.project);
  return hasBookings ? "in arbeit" : "fehlt";
}

async function syncRiderStatuses() {
  for (const ev of eventsData) {
    const computed = riderStatusFor(ev);
    if (computed === "in arbeit" && ev.items.rider.status === "fehlt") {
      const riderDef = EVENT_ITEMS.find((d) => d.key === "rider");
      try {
        await apiFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${eventsSheetRange(`${riderDef.statusCol}${ev.rowIndex}`)}?valueInputOption=RAW`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values: [["in arbeit"]] }),
          }
        );
        ev.items.rider.status = "in arbeit";
      } catch (e) {
        // still show computed state locally even if the write fails
      }
    }
  }
}

let riderModalRowIndex = null;

function openRiderModal(rowIndex) {
  const ev = eventsData.find((e) => e.rowIndex === rowIndex);
  if (!ev) return;
  riderModalRowIndex = rowIndex;

  document.getElementById("rider-modal-title").textContent = `Technical Rider — ${ev.project}`;

  const projectBookings = bookings.filter((b) => b.project === ev.project);
  const listEl = document.getElementById("rider-modal-list");
  listEl.innerHTML = projectBookings.length
    ? projectBookings
        .map((b) => {
          const dateLabel = b.date ? new Date(b.date + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "—";
          return `<div class="rider-list-row">
            <span>${escapeHtml(b.equipment)}</span>
            <span class="qty">${b.qty}× · ${dateLabel}</span>
            <button type="button" class="rider-delete-booking" data-booking-row="${b.rowIndex}" title="Buchung entfernen"><i class="ti ti-trash"></i></button>
          </div>`;
        })
        .join("")
    : `<div class="empty">Noch nichts aus dem Inventar gebucht.</div>`;

  listEl.querySelectorAll(".rider-delete-booking").forEach((btn) => {
    btn.addEventListener("click", () => deleteBooking(parseInt(btn.dataset.bookingRow, 10)));
  });

  document.getElementById("rider-done-checkbox").checked = ev.items.rider.status === "vorhanden";
  document.getElementById("rider-modal").classList.remove("hidden");
}

function closeRiderModal() {
  document.getElementById("rider-modal").classList.add("hidden");
  riderModalRowIndex = null;
}

async function setRiderDone(done) {
  if (!riderModalRowIndex) return;
  const ev = eventsData.find((e) => e.rowIndex === riderModalRowIndex);
  if (!ev) return;
  const riderDef = EVENT_ITEMS.find((d) => d.key === "rider");
  const newStatus = done ? "vorhanden" : bookings.some((b) => b.project === ev.project) ? "in arbeit" : "fehlt";
  try {
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${eventsSheetRange(`${riderDef.statusCol}${ev.rowIndex}`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[newStatus]] }),
      }
    );
    ev.items.rider.status = newStatus;
    renderEvents();
  } catch (e) {
    setStatus("Status konnte nicht gespeichert werden: " + e.message, true);
  }
}

async function deleteBooking(bookingRowIndex) {
  const range = invSheetRange(CONFIG.BOOKINGS_SHEET_NAME, `A${bookingRowIndex}:E${bookingRowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [["", "", "", "", ""]] }),
    });
    bookings = bookings.filter((b) => b.rowIndex !== bookingRowIndex);
    setStatus("Buchung entfernt.");
    if (riderModalRowIndex) openRiderModal(riderModalRowIndex);
    renderInventory();
  } catch (e) {
    setStatus("Buchung konnte nicht entfernt werden: " + e.message, true);
  }
}

function downloadRiderCsv(rowIndex) {
  const targetRow = rowIndex || riderModalRowIndex;
  if (!targetRow) return;
  const ev = eventsData.find((e) => e.rowIndex === targetRow);
  if (!ev) return;
  const projectBookings = bookings.filter((b) => b.project === ev.project);

  const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["Equipment", "Anzahl", "Datum", "Notiz"].map(csvEscape).join(";")];
  projectBookings.forEach((b) => {
    lines.push([b.equipment, b.qty, b.date, b.note].map(csvEscape).join(";"));
  });
  const csvContent = "\uFEFF" + lines.join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `technical-rider-${ev.project.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Inventar ----------

const NEED_PREFIX = "🔧 Technik: ";
let inventoryItems = []; // [{name, category, stock, note}]
let bookings = [];       // [{equipment, project, qty, note}]

function invSheetRange(sheetName, a1) {
  return `${encodeURIComponent(sheetName)}!${a1}`;
}

async function loadInventory() {
  try {
    const invUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${invSheetRange(CONFIG.INVENTORY_SHEET_NAME, "A2:D100")}`;
    const bkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${invSheetRange(CONFIG.BOOKINGS_SHEET_NAME, "A2:E200")}`;
    const [invData, bkData] = await Promise.all([apiFetch(invUrl), apiFetch(bkUrl)]);

    inventoryItems = (invData.values || [])
      .filter((r) => r[0])
      .map((r) => ({ name: r[0], category: r[1] || "", stock: parseFloat(r[2]) || 0, note: r[3] || "" }));

    bookings = (bkData.values || [])
      .filter((r) => r[0])
      .map((r, i) => ({ rowIndex: i + 2, equipment: r[0], project: r[1] || "", date: r[2] || "", qty: parseFloat(r[3]) || 0, note: r[4] || "" }));
  } catch (e) {
    setStatus("Inventar konnte nicht geladen werden: " + e.message, true);
  }
}

function bookedQtyForDate(equipmentName, date) {
  return bookings
    .filter((b) => b.equipment === equipmentName && b.date === date)
    .reduce((sum, b) => sum + b.qty, 0);
}

function eventProjectNames() {
  return eventsData.length ? eventsData.map((e) => e.project) : projectList.filter((p) => p !== "Allgemeines" && p !== "Marketing");
}

function renderInventory() {
  const container = document.getElementById("inventory-list");
  if (!container) return;

  const categoryOrder = ["Beschallung", "Video", "Sonstiges", "Bühne", "Beleuchtung", "Verbrauchsmaterial"];
  const grouped = {};
  inventoryItems.forEach((item, idx) => {
    const cat = item.category || "Sonstiges";
    (grouped[cat] = grouped[cat] || []).push({ item, idx });
  });
  const categories = Object.keys(grouped).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b) || a.localeCompare(b)
  );

  const rowHtml = (item, idx) => {
    const projects = eventProjectNames();
    const projectOptions = projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");

    const itemBookings = bookings
      .filter((b) => b.equipment === item.name)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    const bookingsList = itemBookings.length
      ? itemBookings
          .map((b) => {
            const dateLabel = b.date ? new Date(b.date + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "(kein Datum)";
            return `<div class="inv-booking-entry">${dateLabel} · ${escapeHtml(b.project)} · ${b.qty}×</div>`;
          })
          .join("")
      : `<div class="inv-booking-entry inv-booking-empty">Noch keine Buchungen.</div>`;

    return `<div class="inv-row">
        <div class="inv-name">${escapeHtml(item.name)}${item.note ? `<div class="inv-cat">${escapeHtml(item.note)}</div>` : ""}</div>
        <div class="inv-cat">${escapeHtml(item.category)}</div>
        <div class="inv-avail">${item.stock}</div>
        <button type="button" class="btn inv-book-btn" data-idx="${idx}">Buchen</button>
      </div>
      <div class="inv-book-form" id="inv-book-form-${idx}">
        <div class="inv-book-row">
          <select id="inv-book-project-${idx}"><option value="">Event…</option>${projectOptions}</select>
          <input type="date" id="inv-book-date-${idx}" />
          <input type="number" id="inv-book-qty-${idx}" min="1" value="1" />
          <button type="button" class="btn primary" data-confirm-idx="${idx}">Speichern</button>
        </div>
        <div class="inv-book-availability" id="inv-book-avail-${idx}">Datum wählen, um Verfügbarkeit zu sehen.</div>
        <div class="inv-bookings-list">${bookingsList}</div>
      </div>`;
  };

  container.innerHTML = categories.length
    ? categories
        .map((cat) => {
          const items = grouped[cat];
          return `<details class="inv-category">
            <summary>${escapeHtml(cat)} <span class="inv-category-count">${items.length}</span></summary>
            <div class="inv-table">
              <div class="inv-row inv-header">
                <div class="inv-name">Equipment</div>
                <div class="inv-cat">Kategorie</div>
                <div class="inv-avail">Bestand</div>
                <div style="width:70px"></div>
              </div>
              ${items.map(({ item, idx }) => rowHtml(item, idx)).join("")}
            </div>
          </details>`;
        })
        .join("")
    : `<div class="empty">Noch keine Equipment-Einträge im Inventar-Blatt.</div>`;

  container.querySelectorAll(".inv-book-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.idx;
      document.getElementById(`inv-book-form-${idx}`).classList.toggle("open");
    });
  });

  inventoryItems.forEach((item, idx) => {
    const projectSelect = document.getElementById(`inv-book-project-${idx}`);
    const dateInput = document.getElementById(`inv-book-date-${idx}`);
    const qtyInput = document.getElementById(`inv-book-qty-${idx}`);
    const availEl = document.getElementById(`inv-book-avail-${idx}`);
    const updateAvail = () => {
      if (!dateInput.value) {
        availEl.textContent = "Datum wählen, um Verfügbarkeit zu sehen.";
        availEl.className = "inv-book-availability";
        return;
      }
      const booked = bookedQtyForDate(item.name, dateInput.value);
      const available = item.stock - booked;
      const wanted = parseFloat(qtyInput.value) || 0;
      const dateLabel = new Date(dateInput.value + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
      availEl.textContent = `Verfügbar am ${dateLabel}: ${available} von ${item.stock}${wanted > available ? " — nicht genug frei!" : ""}`;
      availEl.className = "inv-book-availability" + (wanted > available ? " over" : "");
    };
    projectSelect.addEventListener("change", () => {
      // Datum des gewählten Events automatisch als Vorschlag übernehmen,
      // sofern noch kein eigenes Datum gesetzt wurde
      const selectedEvent = eventsData.find((ev) => ev.project === projectSelect.value);
      if (selectedEvent && selectedEvent.date && !dateInput.value) {
        dateInput.value = selectedEvent.date;
        updateAvail();
      }
    });
    dateInput.addEventListener("change", updateAvail);
    qtyInput.addEventListener("input", updateAvail);
  });

  container.querySelectorAll("[data-confirm-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.confirmIdx;
      const item = inventoryItems[idx];
      const project = document.getElementById(`inv-book-project-${idx}`).value;
      const date = document.getElementById(`inv-book-date-${idx}`).value;
      const qty = parseFloat(document.getElementById(`inv-book-qty-${idx}`).value) || 0;
      if (!project || !date || qty <= 0) {
        setStatus("Bitte Event, Datum und eine gültige Anzahl angeben.", true);
        return;
      }
      const alreadyBooked = bookedQtyForDate(item.name, date);
      if (qty > item.stock - alreadyBooked) {
        setStatus("Nicht genug verfügbar an diesem Tag — Buchung wurde nicht gespeichert.", true);
        return;
      }
      addBooking(item.name, project, date, qty);
    });
  });

  renderNeeds();
}

async function addBooking(equipment, project, date, qty) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${invSheetRange(CONFIG.BOOKINGS_SHEET_NAME, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  try {
    const resp = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[equipment, project, date, qty, ""]] }),
    });
    const updatedRange = resp?.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/![A-Z]+(\d+)/);
    const newRowIndex = rowMatch ? parseInt(rowMatch[1], 10) : null;
    bookings.push({ rowIndex: newRowIndex, equipment, project, date, qty, note: "" });
    setStatus("Buchung gespeichert.");
    renderInventory();
  } catch (e) {
    setStatus("Buchung konnte nicht gespeichert werden: " + e.message, true);
  }
}

function renderNeeds() {
  const projSelect = document.getElementById("need-project-select");
  const assigneeSelect = document.getElementById("need-assignee-select");
  if (projSelect) fillSelect(projSelect, eventProjectNames());
  if (assigneeSelect) fillSelect(assigneeSelect, peopleList.map((p) => p.name));

  const needsList = document.getElementById("needs-list");
  if (!needsList) return;

  const needs = tasks.filter((t) => t.title.startsWith(NEED_PREFIX) && t.status !== "erledigt");
  needsList.innerHTML = needs.length
    ? needs
        .map(
          (t) => `<div class="need-item">
            <div>
              <div class="title">${escapeHtml(t.title.replace(NEED_PREFIX, ""))}</div>
              <div class="meta">${escapeHtml(t.project)} · ${escapeHtml(t.assigneeName || "niemand zugewiesen")}</div>
            </div>
            <div class="task-due ${urgencyOf(t.due)}">${formatDue(t.due, urgencyOf(t.due))}</div>
          </div>`
        )
        .join("")
    : `<div class="empty">Kein zusätzlicher Bedarf offen.</div>`;
}

async function handleNewNeed(e) {
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  const project = form.project.value;
  const assigneeName = form.assigneeName.value;
  const due = form.due.value;

  if (!title || !due) {
    setStatus("Titel und Deadline sind Pflichtfelder.", true);
    return;
  }

  try {
    await createTaskRow({
      title: NEED_PREFIX + title,
      project,
      festival: CONFIG.DEFAULT_FESTIVAL || "",
      assigneeName,
      due,
      initialNote: "",
    });
    form.reset();
    setStatus("Bedarf angelegt — erscheint auch im Aufgaben-Reiter.");
    await loadTasks();
    renderNeeds();
  } catch (e) {
    setStatus("Bedarf konnte nicht angelegt werden: " + e.message, true);
  }
}

// ---------- Events ----------

const EVENT_ITEMS = [
  { key: "probenplan", label: "Probenplan", statusCol: "C", linkCol: "D" },
  { key: "rider", label: "Technical Rider", statusCol: "E", linkCol: "F" },
  { key: "bilder", label: "Bilder", statusCol: "G", linkCol: "H" },
  { key: "texte", label: "Texte (Ensemble & Komponist:in)", statusCol: "I", linkCol: "J" },
  { key: "vertragKomponist", label: "Vertrag Komponist:in", statusCol: "K", linkCol: "L" },
  { key: "vertragEnsemble", label: "Vertrag Ensemble", statusCol: "M", linkCol: "N" },
];

let eventsData = []; // [{rowIndex, project, items: {key: {status, link}}}]

function eventsSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.EVENTS_SHEET_NAME)}!${a1}`;
}

async function loadEvents() {
  try {
    const range = eventsSheetRange("A2:N50");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}`;
    const data = await apiFetch(url);
    const rows = data.values || [];
    eventsData = rows
      .filter((r) => r[0])
      .map((r, i) => {
        const items = {};
        EVENT_ITEMS.forEach((def, idx) => {
          const statusIdx = 2 + idx * 2;
          const linkIdx = 3 + idx * 2;
          items[def.key] = {
            status: (r[statusIdx] || "fehlt").trim().toLowerCase(),
            link: r[linkIdx] || "",
          };
        });
        return { rowIndex: i + 2, project: r[0], date: r[1] || "", items };
      });
  } catch (e) {
    setStatus("Events konnten nicht geladen werden: " + e.message, true);
  }
}

function renderEvents() {
  const container = document.getElementById("events-list");
  if (!container) return;

  if (eventsData.length === 0) {
    container.innerHTML = `<div class="empty">Keine Events gefunden. Lege im Events-Blatt Zeilen für deine Projekte an.</div>`;
    return;
  }

  container.innerHTML = eventsData
    .map((ev, idx) => {
      const colorClass = `color-${idx % 5}`;
      const doneCount = EVENT_ITEMS.filter((def) => ev.items[def.key].status === "vorhanden").length;
      const complete = doneCount === EVENT_ITEMS.length;

      const rows = EVENT_ITEMS.map((def) => {
        const item = ev.items[def.key];

        if (def.key === "rider") {
          const computed = riderStatusFor(ev);
          const pillClass = computed === "vorhanden" ? "vorhanden" : computed === "in arbeit" ? "in-arbeit" : "fehlt";
          const pillLabel = computed === "vorhanden" ? "Vorhanden" : computed === "in arbeit" ? "In Arbeit" : "Fehlt";
          return `<div class="checklist-row">
            <div class="checklist-label checklist-label-link" data-row="${ev.rowIndex}" data-open-rider="1">${escapeHtml(def.label)}</div>
            <span class="status-pill ${pillClass} static">${pillLabel}</span>
            <button type="button" class="checklist-link-open rider-download" data-row="${ev.rowIndex}" title="CSV herunterladen"><i class="ti ti-download"></i></button>
          </div>`;
        }

        const isDone = item.status === "vorhanden";
        return `<div class="checklist-row">
          <div class="checklist-label">${escapeHtml(def.label)}</div>
          <button type="button" class="status-pill ${isDone ? "vorhanden" : "fehlt"}"
            data-row="${ev.rowIndex}" data-statuscol="${def.statusCol}" data-key="${def.key}">
            ${isDone ? "Vorhanden" : "Fehlt"}
          </button>
          <input type="text" class="checklist-link" placeholder="Link (Google Drive o.ä.)"
            value="${escapeHtml(item.link)}"
            data-row="${ev.rowIndex}" data-linkcol="${def.linkCol}" data-key="${def.key}" />
          ${item.link ? `<a class="checklist-link-open" href="${escapeHtml(item.link)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i></a>` : `<span class="checklist-link-open"></span>`}
        </div>`;
      }).join("");

      return `<div class="event-card ${colorClass}">
        <div class="event-card-header">
          <div class="event-card-title">${escapeHtml(ev.project)}</div>
          <div class="event-completion ${complete ? "complete" : "incomplete"}">${doneCount}/${EVENT_ITEMS.length} vorhanden</div>
        </div>
        <div class="event-date-row">
          <i class="ti ti-calendar-event"></i>
          <input type="date" class="event-date-input" value="${escapeHtml(ev.date)}" data-row="${ev.rowIndex}" />
        </div>
        ${rows}
      </div>`;
    })
    .join("");

  container.querySelectorAll(".checklist-label-link[data-open-rider]").forEach((el) => {
    el.addEventListener("click", () => openRiderModal(parseInt(el.dataset.row, 10)));
  });

  container.querySelectorAll(".rider-download").forEach((btn) => {
    btn.addEventListener("click", () => downloadRiderCsv(parseInt(btn.dataset.row, 10)));
  });

  container.querySelectorAll(".status-pill:not(.static)").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rowIndex = parseInt(btn.dataset.row, 10);
      toggleEventStatus(rowIndex, btn.dataset.statuscol, btn.dataset.key);
    });
  });

  container.querySelectorAll(".checklist-link").forEach((input) => {
    input.addEventListener("change", () => {
      const rowIndex = parseInt(input.dataset.row, 10);
      updateEventLink(rowIndex, input.dataset.linkcol, input.dataset.key, input.value.trim());
    });
  });

  container.querySelectorAll(".event-date-input").forEach((input) => {
    input.addEventListener("change", () => {
      const rowIndex = parseInt(input.dataset.row, 10);
      updateEventDate(rowIndex, input.value);
    });
  });
}

async function updateEventDate(rowIndex, date) {
  const ev = eventsData.find((e) => e.rowIndex === rowIndex);
  if (!ev) return;
  const range = eventsSheetRange(`B${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[date]] }),
    });
    ev.date = date;
    setStatus("Termin gespeichert.");
  } catch (e) {
    setStatus("Termin konnte nicht gespeichert werden: " + e.message, true);
  }
}

async function toggleEventStatus(rowIndex, col, key) {
  const ev = eventsData.find((e) => e.rowIndex === rowIndex);
  if (!ev) return;
  const newStatus = ev.items[key].status === "vorhanden" ? "fehlt" : "vorhanden";
  const range = eventsSheetRange(`${col}${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[newStatus]] }),
    });
    ev.items[key].status = newStatus;
    renderEvents();
  } catch (e) {
    setStatus("Status konnte nicht gespeichert werden: " + e.message, true);
  }
}

async function updateEventLink(rowIndex, col, key, value) {
  const ev = eventsData.find((e) => e.rowIndex === rowIndex);
  if (!ev) return;
  const range = eventsSheetRange(`${col}${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
  try {
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[value]] }),
    });
    ev.items[key].link = value;
    renderEvents();
  } catch (e) {
    setStatus("Link konnte nicht gespeichert werden: " + e.message, true);
  }
}
