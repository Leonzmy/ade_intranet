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
let lastLoadedEvents = []; // alle Events der aktuellen Ansicht (für Detail-Modal)

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
  els.riderBookBtn = document.getElementById("rider-book-btn");
  els.contractModalClose = document.getElementById("contract-modal-close");
  els.contractGenerateBtn = document.getElementById("contract-generate-btn");

  bindClick(els.calPrev, () => shiftCalendar(-1));
  bindClick(els.calNext, () => shiftCalendar(1));
  bindClick(els.calToday, () => { calAnchor = new Date(); loadCalendar(); });
  bindClick(els.calViewMonth, () => setCalView("month"));
  bindClick(els.calViewWeek, () => setCalView("week"));
  bindClick(els.calNewEventBtn, () => els.newEventForm && els.newEventForm.classList.toggle("hidden"));
  bindSubmit(els.newEventForm, handleNewEvent);
  bindClick(els.riderModalClose, closeRiderModal);
  bindClick(els.riderCsvBtn, downloadRiderCsv);
  bindClick(els.riderBookBtn, () => {
    if (!riderModalRowIndex) return;
    const ev = eventsData.find((e) => e.rowIndex === riderModalRowIndex);
    if (!ev) return;
    goToInventoryForBooking(ev.project, ev.date);
  });
  bindClick(els.contractModalClose, closeContractModal);
  bindClick(els.contractGenerateBtn, handleGenerateContract);
  bindClick(document.getElementById("bio-modal-close"), closeBioModal);
  bindClick(document.getElementById("termin-modal-close"), closeTerminModal);
  bindClick(document.getElementById("termin-delete-btn"), deleteTermin);
  const terminModalEl = document.getElementById("termin-modal");
  if (terminModalEl) {
    terminModalEl.addEventListener("click", (e) => {
      if (e.target === terminModalEl) closeTerminModal();
    });
  }
  const bioModalEl = document.getElementById("bio-modal");
  if (bioModalEl) {
    bioModalEl.addEventListener("click", (e) => {
      if (e.target === bioModalEl) closeBioModal();
    });
  }
  const contractModalEl = document.getElementById("contract-modal");
  if (contractModalEl) {
    contractModalEl.addEventListener("click", (e) => {
      if (e.target === contractModalEl) closeContractModal();
    });
  }
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
  await loadContacts();
  await syncContacts();
  await loadContractTemplates();
  await loadContractDetails();
  await loadProgrammheft();
  await syncProgrammheft();
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
    fillAttendeeSelect();
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
      }))
      .filter((t) => t.title);
    renderTasks();
  } catch (e) {
    setStatus("Konnte Aufgaben nicht laden: " + e.message, true);
  }
}

// ---------- Deadline-Synchronisation ----------

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return dateKey(d);
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
  // Bewusst lokale Datumsteile statt toISOString(): letzteres rechnet nach UTC
  // um und verschiebt dadurch je nach Zeitzone den Tag.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

const EVENT_CATEGORIES = {
  "Organisationstreffen": { cls: "orga", colorId: "9" },   // Blau
  "Probe": { cls: "probe", colorId: "10" },                // Grün
  "Konzert": { cls: "konzert", colorId: "11" },            // Rot
  "Konzertbesuch": { cls: "besuch", colorId: "5" },        // Gelb
};

// Kategorie aus den erweiterten Eigenschaften lesen; bei Terminen, die direkt
// in Google Calendar angelegt wurden, gibt es keine — dann "sonstige".
function categoryOf(ev) {
  const cat = ev.extendedProperties?.private?.fdCategory;
  return cat && EVENT_CATEGORIES[cat] ? cat : null;
}

function categoryClassOf(ev) {
  if (isDeadlineEvent(ev)) return "";
  const cat = categoryOf(ev);
  return cat ? `is-${EVENT_CATEGORIES[cat].cls}` : "is-event";
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
        const cls = categoryClassOf(ev);
        return `<div class="cal-chip ${cls}" data-event-id="${escapeHtml(ev.id)}" title="${escapeHtml(ev.summary || "")}">${escapeHtml(ev.summary || "(ohne Titel)")}</div>`;
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

  if (targetEl === els.calGrid) {
    lastLoadedEvents = events;
    targetEl.querySelectorAll("[data-event-id]").forEach((el) => {
      el.addEventListener("click", () => openTerminModal(el.dataset.eventId));
    });
  }
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
        const cls = isDeadline ? "is-deadline" : categoryClassOf(ev);
        const time = ev.start.dateTime
          ? new Date(ev.start.dateTime).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
          : "ganztägig";
        return `<div class="cal-week-event ${cls}" data-event-id="${escapeHtml(ev.id)}">
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
  lastLoadedEvents = events;
  els.calGrid.querySelectorAll("[data-event-id]").forEach((el) => {
    el.addEventListener("click", () => openTerminModal(el.dataset.eventId));
  });
}

async function handleNewEvent(e) {
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  const date = form.date.value;
  const time = form.time.value;
  const category = form.category.value;
  const location = form.location.value.trim();
  const zoomLink = form.zoomLink.value.trim();
  const description = form.description.value.trim();
  const duration = parseInt(form.duration.value, 10) || 60;
  const attendeeEmails = Array.from(form.attendees.selectedOptions).map((o) => o.value).filter(Boolean);

  if (!title || !date) {
    setStatus("Titel und Datum sind Pflichtfelder für einen Termin.", true);
    return;
  }

  const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
  let body;
  if (time) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const startDateTime = `${date}T${time}:00`;

    // Ende bewusst über lokale Datumsteile berechnen — toISOString() würde
    // nach UTC umrechnen und ein Ende VOR dem Start ergeben.
    const endDate = new Date(`${date}T${time}:00`);
    endDate.setMinutes(endDate.getMinutes() + duration);
    const pad = (n) => String(n).padStart(2, "0");
    const endDateTime = `${dateKey(endDate)}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;

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

  // Kategorie als Farbe und als unsichtbare Markierung mitspeichern
  const catDef = EVENT_CATEGORIES[category];
  if (catDef) {
    body.colorId = catDef.colorId;
    body.extendedProperties = { private: { fdCategory: category } };
  }
  if (location) body.location = location;

  const descParts = [];
  if (description) descParts.push(description);
  if (zoomLink) descParts.push(`Zoom: ${zoomLink}`);
  if (descParts.length) body.description = descParts.join("\n\n");

  if (attendeeEmails.length) {
    body.attendees = attendeeEmails.map((email) => ({ email }));
  }

  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?sendUpdates=${attendeeEmails.length ? "all" : "none"}`;
    await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    form.reset();
    els.newEventForm.classList.add("hidden");
    setStatus(attendeeEmails.length ? "Termin gespeichert, Einladungen verschickt." : "Termin gespeichert.");
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
  if (view === "contacts") renderContacts();
  if (view === "contracts") { renderTemplates(); renderContractsBrowser(); }
  if (view === "programmheft") renderProgrammheft();
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

  renderNextEvent();
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

// ---------- Event-Personen & Kontakte ----------

const PEOPLE_ROLES = [
  { key: "ensemble", col: "O", label: "Ensemble" },
  { key: "interpreten", col: "P", label: "Interpret:in" },
  { key: "komponisten", col: "Q", label: "Komponist:in" },
];

async function updateEventPeople(rowIndex, col, value) {
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
    if (col === "O") ev.ensemble = value;
    if (col === "P") ev.interpreten = value;
    if (col === "Q") ev.komponisten = value;
    setStatus("Gespeichert.");
    await syncContacts();
    const contactsView = document.getElementById("view-contacts");
    if (contactsView && !contactsView.classList.contains("hidden")) {
      renderContacts();
    }
  } catch (e) {
    setStatus("Konnte nicht gespeichert werden: " + e.message, true);
  }
}

let contactsData = []; // [{rowIndex, name, role, events, email, address, phone}]

function contactsSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.CONTACTS_SHEET_NAME)}!${a1}`;
}

async function loadContacts() {
  try {
    const range = contactsSheetRange("A2:K300");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}`;
    const data = await apiFetch(url);
    contactsData = (data.values || [])
      .map((r, i) => ({
        rowIndex: i + 2,
        name: r[0],
        role: r[1] || "",
        events: r[2] || "",
        email: r[3] || "",
        street: r[4] || "",
        houseNumber: r[5] || "",
        zip: r[6] || "",
        city: r[7] || "",
        country: r[8] || "",
        phone: r[9] || "",
        token: r[10] || "",
      }))
      .filter((c) => c.name);
  } catch (e) {
    setStatus("Kontakte konnten nicht geladen werden: " + e.message, true);
  }
}

function formatAddress(c) {
  const line1 = [c.street, c.houseNumber].filter(Boolean).join(" ");
  const line2 = [c.zip, c.city].filter(Boolean).join(" ");
  return [line1, line2, c.country].filter(Boolean).join(", ") || "—";
}

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function desiredContactsFromEvents() {
  // Baut aus allen Events eine Map: Name -> { roles:Set, events:Set }
  const map = new Map();
  eventsData.forEach((ev) => {
    PEOPLE_ROLES.forEach((r) => {
      const raw = ev[r.key] || "";
      raw.split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => {
        if (!map.has(name)) map.set(name, { roles: new Set(), events: new Set() });
        map.get(name).roles.add(r.label);
        map.get(name).events.add(ev.project);
      });
    });
  });
  return map;
}

async function syncContacts() {
  const desired = desiredContactsFromEvents();

  for (const [name, info] of desired.entries()) {
    const roleStr = Array.from(info.roles).join(", ");
    const eventsStr = Array.from(info.events).join(", ");
    const existing = contactsData.find((c) => c.name === name);

    if (!existing) {
      const token = genToken();
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${contactsSheetRange("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      try {
        const resp = await apiFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[name, roleStr, eventsStr, "", "", "", "", "", "", "", token]] }),
        });
        const updatedRange = resp?.updates?.updatedRange || "";
        const rowMatch = updatedRange.match(/![A-Z]+(\d+)/);
        const newRowIndex = rowMatch ? parseInt(rowMatch[1], 10) : null;
        contactsData.push({
          rowIndex: newRowIndex, name, role: roleStr, events: eventsStr,
          email: "", street: "", houseNumber: "", zip: "", city: "", country: "", phone: "", token,
        });
      } catch (e) {
        // weiter mit den übrigen Namen, auch wenn einer fehlschlägt
      }
    } else if (existing.role !== roleStr || existing.events !== eventsStr) {
      const range = contactsSheetRange(`B${existing.rowIndex}:C${existing.rowIndex}`);
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
      try {
        await apiFetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[roleStr, eventsStr]] }),
        });
        existing.role = roleStr;
        existing.events = eventsStr;
      } catch (e) {
        // still update locally so the UI reflects reality even if the write failed
        existing.role = roleStr;
        existing.events = eventsStr;
      }
    }
  }
}

function renderContacts() {
  const container = document.getElementById("contacts-list");
  if (!container) return;

  if (contactsData.length === 0) {
    container.innerHTML = `<div class="empty">Noch niemand eingetragen — trag Ensemble, Interpret:innen oder Komponist:innen bei einem Event ein, dann erscheinen sie hier automatisch.</div>`;
    return;
  }

  const header = `<div class="inv-row inv-header contact-row">
    <div class="contact-name">Name</div>
    <div class="contact-role">Rolle</div>
    <div class="contact-field">Email</div>
    <div class="contact-field">Adresse</div>
    <div class="contact-field-sm">Telefon</div>
    <div style="width:36px"></div>
  </div>`;

  const rows = contactsData
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (c) => `<div class="inv-row contact-row">
        <div class="contact-name">${escapeHtml(c.name)}<div class="inv-cat">${escapeHtml(c.events)}</div></div>
        <div class="contact-role">${escapeHtml(c.role)}</div>
        <div class="contact-static">${c.email ? escapeHtml(c.email) : "—"}</div>
        <div class="contact-static">${escapeHtml(formatAddress(c))}</div>
        <div class="contact-static">${c.phone ? escapeHtml(c.phone) : "—"}</div>
        <button type="button" class="contact-link-btn" data-row="${c.rowIndex}" title="Formular-Link kopieren"><i class="ti ti-link"></i></button>
      </div>`
    )
    .join("");

  container.innerHTML = header + rows;

  container.querySelectorAll(".contact-link-btn").forEach((btn) => {
    btn.addEventListener("click", () => copyContactLink(parseInt(btn.dataset.row, 10)));
  });
}

async function copyContactLink(rowIndex) {
  const c = contactsData.find((x) => x.rowIndex === rowIndex);
  if (!c) return;

  if (!c.token) {
    const newToken = genToken();
    const range = contactsSheetRange(`K${rowIndex}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
    try {
      await apiFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[newToken]] }),
      });
      c.token = newToken;
    } catch (e) {
      setStatus("Zugriffsschlüssel konnte nicht erzeugt werden: " + e.message, true);
      return;
    }
  }

  const link = `${CONFIG.PUBLIC_FORM_URL}?row=${c.rowIndex}&token=${encodeURIComponent(c.token)}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus(`Link für ${c.name} kopiert — einfach einfügen und verschicken.`);
  } catch (e) {
    window.prompt("Link kopieren (Strg+C):", link);
  }
}

// ---------- Rider-Status & Modal ----------

function riderStatusFor(ev) {
  const stored = ev.items.rider.status;
  if (stored === "vorhanden") return "vorhanden";
  const hasBookings = bookings.some((b) => b.project === ev.project);
  return hasBookings ? "in arbeit" : "fehlt";
}

function contractsStatusFor(ev) {
  const pairs = [];
  (ev.ensemble || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => pairs.push({ name, role: "Ensemble" }));
  (ev.interpreten || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => pairs.push({ name, role: "Interpret:in" }));
  (ev.komponisten || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => pairs.push({ name, role: "Komponist:in" }));

  if (pairs.length === 0) return { status: "fehlt", done: 0, total: 0 };

  const done = pairs.filter((p) =>
    contractDetails.some((c) => c.name === p.name && c.event === ev.project && c.role === p.role)
  ).length;

  if (done === 0) return { status: "fehlt", done, total: pairs.length };
  if (done === pairs.length) return { status: "vorhanden", done, total: pairs.length };
  return { status: "in arbeit", done, total: pairs.length };
}

// Alle Personen eines Events (über alle drei Rollen hinweg, ohne Dubletten)
function peopleOfEvent(ev) {
  const names = new Set();
  PEOPLE_ROLES.forEach((r) => {
    (ev[r.key] || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
  });
  return Array.from(names);
}

// Status für Bilder (Fotos) bzw. Texte (Bios) aus den Programmheft-Daten
function programmheftStatusFor(ev, field) {
  const names = peopleOfEvent(ev);
  if (names.length === 0) return { status: "fehlt", done: 0, total: 0 };

  const done = names.filter((name) => {
    const entry = programmheftData.find((p) => p.name === name);
    return entry && entry[field];
  }).length;

  if (done === 0) return { status: "fehlt", done, total: names.length };
  if (done === names.length) return { status: "vorhanden", done, total: names.length };
  return { status: "in arbeit", done, total: names.length };
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
let pendingBooking = null; // { project, date } — vom Rider-Popup übernommen

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

function goToInventoryForBooking(project, date) {
  pendingBooking = { project, date: date || "" };
  closeRiderModal();
  switchView("inventory");
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
      .map((r, i) => ({ rowIndex: i + 2, equipment: r[0], project: r[1] || "", date: r[2] || "", qty: parseFloat(r[3]) || 0, note: r[4] || "" }))
      .filter((b) => b.equipment);
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

    if (pendingBooking) {
      if (pendingBooking.project) projectSelect.value = pendingBooking.project;
      if (pendingBooking.date) dateInput.value = pendingBooking.date;
      updateAvail();
    }
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

  if (pendingBooking) {
    setStatus(`Event "${pendingBooking.project}" vorausgefüllt — bei der gewünschten Position auf "Buchen" klicken, oder unten als zusätzlichen Bedarf eintragen.`);
    pendingBooking = null;
  }
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
  const dueInput = document.getElementById("need-due-input");
  if (projSelect) fillSelect(projSelect, eventProjectNames());
  if (assigneeSelect) fillSelect(assigneeSelect, peopleList.map((p) => p.name));

  if (pendingBooking && projSelect && dueInput) {
    if (pendingBooking.project) projSelect.value = pendingBooking.project;
    if (pendingBooking.date) dueInput.value = pendingBooking.date;
  }

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
];

let eventsData = []; // [{rowIndex, project, items: {key: {status, link}}}]

function eventsSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.EVENTS_SHEET_NAME)}!${a1}`;
}

async function loadEvents() {
  try {
    const range = eventsSheetRange("A2:R50");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}`;
    const data = await apiFetch(url);
    const rows = data.values || [];
    eventsData = rows
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
        return {
          rowIndex: i + 2,
          project: r[0],
          date: r[1] || "",
          items,
          ensemble: r[14] || "",
          interpreten: r[15] || "",
          komponisten: r[16] || "",
          programmtext: r[17] || "",
        };
      })
      .filter((ev) => ev.project);
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
      const contractsInfo = contractsStatusFor(ev);
      const bilderInfo = programmheftStatusFor(ev, "photoUrl");
      const texteInfo = programmheftStatusFor(ev, "bio");
      const manualDone = EVENT_ITEMS
        .filter((def) => def.key !== "rider" && def.key !== "bilder" && def.key !== "texte")
        .filter((def) => ev.items[def.key].status === "vorhanden").length;
      const doneCount = manualDone
        + (riderStatusFor(ev) === "vorhanden" ? 1 : 0)
        + (bilderInfo.status === "vorhanden" ? 1 : 0)
        + (texteInfo.status === "vorhanden" ? 1 : 0)
        + (contractsInfo.status === "vorhanden" ? 1 : 0);
      const totalCount = EVENT_ITEMS.length + 1;
      const complete = doneCount === totalCount;

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

        if (def.key === "bilder" || def.key === "texte") {
          const field = def.key === "bilder" ? "photoUrl" : "bio";
          const info = programmheftStatusFor(ev, field);
          const pillClass = info.status === "vorhanden" ? "vorhanden" : info.status === "in arbeit" ? "in-arbeit" : "fehlt";
          const pillLabel = info.status === "vorhanden" ? "Fertig" : info.status === "in arbeit" ? "In Arbeit" : "Fehlt";
          const label = def.key === "bilder" ? "Bilder" : "Texte";
          return `<div class="checklist-row">
            <div class="checklist-label checklist-label-link" data-open-programmheft="1">${escapeHtml(label)}</div>
            <span class="status-pill ${pillClass} static">${pillLabel}</span>
            <span class="checklist-link-open" style="color:var(--text-muted); font-size:11px;">${info.done}/${info.total}</span>
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

      const contractsPillClass = contractsInfo.status === "vorhanden" ? "vorhanden" : contractsInfo.status === "in arbeit" ? "in-arbeit" : "fehlt";
      const contractsPillLabel = contractsInfo.status === "vorhanden" ? "Fertig" : contractsInfo.status === "in arbeit" ? "In Arbeit" : "Fehlt";
      const contractsRow = `<div class="checklist-row">
        <div class="checklist-label checklist-label-link" data-open-contracts="1">Verträge</div>
        <span class="status-pill ${contractsPillClass} static">${contractsPillLabel}</span>
        <span class="checklist-link-open" style="color:var(--text-muted); font-size:11px;">${contractsInfo.done}/${contractsInfo.total}</span>
      </div>`;

      return `<div class="event-card ${colorClass}">
        <div class="event-card-header">
          <div class="event-card-title">${escapeHtml(ev.project)}</div>
          <div class="event-completion ${complete ? "complete" : "incomplete"}">${doneCount}/${totalCount} vorhanden</div>
        </div>
        <div class="event-date-row">
          <i class="ti ti-calendar-event"></i>
          <input type="date" class="event-date-input" value="${escapeHtml(ev.date)}" data-row="${ev.rowIndex}" />
        </div>
        <div class="event-people">
          <div class="event-people-field">
            <div class="people-toggle">
              <button type="button" class="people-toggle-btn ${ev.interpreten && !ev.ensemble ? "" : "active"}" data-row="${ev.rowIndex}" data-mode="ensemble">Ensemble</button>
              <button type="button" class="people-toggle-btn ${ev.interpreten && !ev.ensemble ? "active" : ""}" data-row="${ev.rowIndex}" data-mode="interpreten">Interpret:innen</button>
            </div>
            <input type="text" class="event-people-input" placeholder="Name(n), mit Komma trennen"
              value="${escapeHtml(ev.interpreten && !ev.ensemble ? ev.interpreten : ev.ensemble)}"
              data-row="${ev.rowIndex}" data-people-col="${ev.interpreten && !ev.ensemble ? "P" : "O"}" />
          </div>
          <div class="event-people-field">
            <label>Komponist:innen</label>
            <input type="text" class="event-people-input" placeholder="Name(n), mit Komma trennen"
              value="${escapeHtml(ev.komponisten)}" data-row="${ev.rowIndex}" data-people-col="Q" />
          </div>
        </div>
        ${rows}
        ${contractsRow}
      </div>`;
    })
    .join("");

  container.querySelectorAll(".people-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rowIndex = parseInt(btn.dataset.row, 10);
      const mode = btn.dataset.mode;
      const ev = eventsData.find((e) => e.rowIndex === rowIndex);
      if (!ev) return;

      // Beim Umschalten den Inhalt in die andere Spalte übernehmen und die
      // ursprüngliche leeren — so ist immer nur eines von beiden gefüllt.
      const current = ev.interpreten && !ev.ensemble ? ev.interpreten : ev.ensemble;
      if (mode === "ensemble") {
        await updateEventPeople(rowIndex, "P", "");
        await updateEventPeople(rowIndex, "O", current || "");
      } else {
        await updateEventPeople(rowIndex, "O", "");
        await updateEventPeople(rowIndex, "P", current || "");
      }
      renderEvents();
    });
  });

  container.querySelectorAll(".event-people-input").forEach((input) => {
    input.addEventListener("change", () => {
      const rowIndex = parseInt(input.dataset.row, 10);
      updateEventPeople(rowIndex, input.dataset.peopleCol, input.value);
    });
  });

  container.querySelectorAll(".checklist-label-link[data-open-rider]").forEach((el) => {
    el.addEventListener("click", () => openRiderModal(parseInt(el.dataset.row, 10)));
  });

  container.querySelectorAll(".checklist-label-link[data-open-contracts]").forEach((el) => {
    el.addEventListener("click", () => switchView("contracts"));
  });

  container.querySelectorAll(".checklist-label-link[data-open-programmheft]").forEach((el) => {
    el.addEventListener("click", () => switchView("programmheft"));
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

// ---------- Verträge ----------

const CONTRACT_ROLES = [
  { key: "ensemble", label: "Ensemble", category: "Ensemble" },
  { key: "interpreten", label: "Interpret:innen", category: "Interpret:in" },
  { key: "komponisten", label: "Komponist:innen", category: "Komponist:in" },
];

const CONTRACT_ROLE_FIELDS = {
  "Ensemble": [{ key: "GESAMTSUMME", label: "Vereinbarte Gesamtsumme" }],
  "Interpret:in": [{ key: "INSTRUMENT", label: "Instrument" }],
  "Komponist:in": [
    { key: "LAENGE", label: "Länge der Komposition" },
    { key: "HONORAR", label: "Vereinbartes Honorar" },
  ],
};

let contractTemplates = {}; // { "Ensemble": url, "Interpret:in": url, "Komponist:in": url }
let contractDetails = [];   // [{name, event, role, ...fields, docUrl, pdfUrl, createdAt}]
let contractModalContext = null; // { name, event, category, roleKey }

function templatesSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.CONTRACT_TEMPLATES_SHEET_NAME)}!${a1}`;
}

function contractDetailsSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.CONTRACT_DETAILS_SHEET_NAME)}!${a1}`;
}

async function loadContractTemplates() {
  // Fest hinterlegt in config.js — bewusst nicht im Frontend editierbar
  contractTemplates = { ...CONFIG.CONTRACT_TEMPLATES };
}

async function loadContractDetails() {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${contractDetailsSheetRange("A2:J300")}`;
    const data = await apiFetch(url);
    contractDetails = (data.values || [])
      .map((r) => ({
        name: r[0], event: r[1], role: r[2],
        instrument: r[3] || "", laenge: r[4] || "", honorar: r[5] || "", gesamtsumme: r[6] || "",
        docUrl: r[7] || "", pdfUrl: r[8] || "", createdAt: r[9] || "",
      }))
      .filter((c) => c.name);
  } catch (e) {
    setStatus("Vertragsdetails konnten nicht geladen werden: " + e.message, true);
  }
}

function renderTemplates() {
  const container = document.getElementById("templates-list");
  if (!container) return;
  const cats = ["Ensemble", "Interpret:in", "Komponist:in"];
  container.innerHTML = cats
    .map((cat) => {
      const url = contractTemplates[cat] || "";
      const titleHtml = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="template-cat-link">${escapeHtml(cat)}</a>`
        : `<span class="template-cat-link muted">${escapeHtml(cat)} <span class="template-missing">— keine Vorlage hinterlegt</span></span>`;
      return `<div class="template-row">${titleHtml}</div>`;
    })
    .join("");
}

function renderContractsBrowser() {
  const container = document.getElementById("contracts-browser");
  if (!container) return;

  const html = CONTRACT_ROLES.map((roleDef) => {
    const eventsWithPeople = eventsData
      .map((ev) => {
        const names = (ev[roleDef.key] || "").split(",").map((s) => s.trim()).filter(Boolean);
        return { event: ev.project, names };
      })
      .filter((e) => e.names.length > 0);

    const totalPeople = eventsWithPeople.reduce((sum, e) => sum + e.names.length, 0);

    if (eventsWithPeople.length === 0) {
      return `<details class="contract-role-group">
        <summary class="contract-role-header"><i class="ti ti-users"></i> ${escapeHtml(roleDef.label)} <span class="contract-count">0</span></summary>
        <div class="contract-role-body"><div class="empty">Noch niemand eingetragen.</div></div>
      </details>`;
    }

    const eventGroups = eventsWithPeople
      .map(({ event, names }) => {
        const rows = names
          .map((name) => {
            const existing = contractDetails.find(
              (c) => c.name === name && c.event === event && c.role === roleDef.category
            );
            const statusLabel = existing ? "Vertrag erstellt" : "Kein Vertrag";
            const statusClass = existing ? "done" : "pending";
            return `<div class="contract-person-row" data-name="${escapeHtml(name)}" data-event="${escapeHtml(event)}" data-category="${escapeHtml(roleDef.category)}" data-rolekey="${roleDef.key}">
              <span class="contract-person-name">${escapeHtml(name)}</span>
              <span class="contract-person-status ${statusClass}">${statusLabel}</span>
            </div>`;
          })
          .join("");
        return `<details class="contract-event-group">
          <summary class="contract-event-label">${escapeHtml(event)} <span class="contract-count">${names.length}</span></summary>
          <div class="contract-event-body">${rows}</div>
        </details>`;
      })
      .join("");

    return `<details class="contract-role-group">
      <summary class="contract-role-header"><i class="ti ti-users"></i> ${escapeHtml(roleDef.label)} <span class="contract-count">${totalPeople}</span></summary>
      <div class="contract-role-body">${eventGroups}</div>
    </details>`;
  }).join("");

  container.innerHTML = html;

  container.querySelectorAll(".contract-person-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openContractModal(row.dataset.name, row.dataset.event, row.dataset.category, row.dataset.rolekey);
    });
  });
}

function openContractModal(name, event, category, roleKey) {
  contractModalContext = { name, event, category, roleKey };

  document.getElementById("contract-modal-title").textContent = `Vertrag — ${name}`;

  const contact = contactsData.find((c) => c.name === name);
  const infoEl = document.getElementById("contract-contact-info");
  infoEl.innerHTML = `
    <div><strong>${escapeHtml(name)}</strong></div>
    <div>${contact && contact.email ? escapeHtml(contact.email) : "Keine E-Mail hinterlegt"}</div>
    <div>${contact ? escapeHtml(formatAddress(contact)) : "—"}</div>
    <div>Event: ${escapeHtml(event)}</div>
  `;

  const fieldsDef = CONTRACT_ROLE_FIELDS[category] || [];
  const existing = contractDetails.find((c) => c.name === name && c.event === event && c.role === category);
  const valueMap = {
    INSTRUMENT: existing?.instrument || "",
    LAENGE: existing?.laenge || "",
    HONORAR: existing?.honorar || "",
    GESAMTSUMME: existing?.gesamtsumme || "",
  };

  const fieldsEl = document.getElementById("contract-fields");
  fieldsEl.innerHTML = `<div class="contract-fields-grid">${fieldsDef
    .map(
      (f) => `<div class="contract-field-card">
        <label for="contract-field-${f.key}">${escapeHtml(f.label)}</label>
        <input type="text" id="contract-field-${f.key}" placeholder="${escapeHtml(f.label)}" value="${escapeHtml(valueMap[f.key] || "")}" />
      </div>`
    )
    .join("")}</div>`;

  const resultEl = document.getElementById("contract-result");
  resultEl.classList.add("hidden");
  resultEl.innerHTML = "";
  if (existing && existing.docUrl) {
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `Zuletzt erstellt: <a href="${escapeHtml(existing.docUrl)}" target="_blank" rel="noopener">Google Doc öffnen</a><a href="${escapeHtml(existing.pdfUrl)}" target="_blank" rel="noopener">Als PDF herunterladen</a>`;
  }

  document.getElementById("contract-status").textContent = "";
  document.getElementById("contract-modal").classList.remove("hidden");
}

function closeContractModal() {
  document.getElementById("contract-modal").classList.add("hidden");
  contractModalContext = null;
}

async function handleGenerateContract() {
  if (!contractModalContext) return;
  const { name, event, category } = contractModalContext;
  const templateUrl = contractTemplates[category];
  if (!templateUrl) {
    setStatus(`Keine Vorlage für "${category}" hinterlegt — erst bei Vorlagen eintragen.`, true);
    return;
  }
  if (!CONFIG.WEBAPP_URL || CONFIG.WEBAPP_URL.startsWith("TRAGE_HIER")) {
    setStatus("WEBAPP_URL ist in config.js noch nicht eingetragen.", true);
    return;
  }

  const contact = contactsData.find((c) => c.name === name);
  const ev = eventsData.find((e) => e.project === event);
  const fieldsDef = CONTRACT_ROLE_FIELDS[category] || [];
  const fields = {
    NAME: name,
    EMAIL: contact?.email || "",
    ADRESSE: contact ? formatAddress(contact) : "",
    EVENT: event,
    DATUM: ev?.date || "",
    FESTIVAL: CONFIG.DEFAULT_FESTIVAL || "",
  };
  fieldsDef.forEach((f) => {
    const input = document.getElementById(`contract-field-${f.key}`);
    fields[f.key] = input ? input.value.trim() : "";
  });

  const statusEl = document.getElementById("contract-status");
  const btn = document.getElementById("contract-generate-btn");
  btn.disabled = true;
  statusEl.textContent = "Wird erstellt…";

  try {
    const res = await fetch(CONFIG.WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "generateContract",
        adminKey: CONFIG.ADMIN_KEY,
        templateUrl,
        name,
        event,
        role: category,
        fields,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      statusEl.textContent = data.error || "Fehler bei der Vertragserstellung.";
      btn.disabled = false;
      return;
    }
    statusEl.textContent = "Vertrag erstellt.";
    const resultEl = document.getElementById("contract-result");
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `<a href="${escapeHtml(data.docUrl)}" target="_blank" rel="noopener">Google Doc öffnen</a><a href="${escapeHtml(data.pdfUrl)}" target="_blank" rel="noopener">Als PDF herunterladen</a>`;
    await loadContractDetails();
    renderContractsBrowser();
  } catch (e) {
    statusEl.textContent = "Fehler bei der Vertragserstellung: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Programmheft ----------

let programmheftData = []; // [{rowIndex, name, role, events, bio, photoUrl, updatedAt, token}]

function programmheftSheetRange(a1) {
  return `${encodeURIComponent(CONFIG.PROGRAMMHEFT_SHEET_NAME)}!${a1}`;
}

async function loadProgrammheft() {
  try {
    const phUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${programmheftSheetRange("A2:G500")}`;
    const phData = await apiFetch(phUrl);

    programmheftData = (phData.values || [])
      .map((r, i) => ({
        rowIndex: i + 2,
        name: r[0],
        role: r[1] || "",
        events: r[2] || "",
        bio: r[3] || "",
        photoUrl: r[4] || "",
        updatedAt: r[5] || "",
        token: r[6] || "",
      }))
      .filter((p) => p.name);
  } catch (e) {
    setStatus("Programmheft-Daten konnten nicht geladen werden: " + e.message, true);
  }
}

// Baut aus den Events die Soll-Liste: alle Personen/Ensembles je Event
function desiredProgrammheftEntries() {
  const map = new Map();
  eventsData.forEach((ev) => {
    PEOPLE_ROLES.forEach((r) => {
      (ev[r.key] || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => {
        if (!map.has(name)) map.set(name, { roles: new Set(), events: new Set() });
        map.get(name).roles.add(r.label);
        map.get(name).events.add(ev.project);
      });
    });
  });
  return map;
}

async function syncProgrammheft() {
  const desired = desiredProgrammheftEntries();

  for (const [name, info] of desired.entries()) {
    const roleStr = Array.from(info.roles).join(", ");
    const eventsStr = Array.from(info.events).join(", ");
    const existing = programmheftData.find((p) => p.name === name);

    if (!existing) {
      const token = genToken();
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${programmheftSheetRange("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      try {
        const resp = await apiFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[name, roleStr, eventsStr, "", "", "", token]] }),
        });
        const updatedRange = resp?.updates?.updatedRange || "";
        const rowMatch = updatedRange.match(/![A-Z]+(\d+)/);
        const newRowIndex = rowMatch ? parseInt(rowMatch[1], 10) : null;
        programmheftData.push({
          rowIndex: newRowIndex, name, role: roleStr, events: eventsStr,
          bio: "", photoUrl: "", updatedAt: "", token,
        });
      } catch (e) {
        // einzelne Fehlschläge nicht den ganzen Sync abbrechen lassen
      }
    } else if (existing.role !== roleStr || existing.events !== eventsStr) {
      const range = programmheftSheetRange(`B${existing.rowIndex}:C${existing.rowIndex}`);
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
      try {
        await apiFetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[roleStr, eventsStr]] }),
        });
      } catch (e) {
        // lokal trotzdem aktualisieren
      }
      existing.role = roleStr;
      existing.events = eventsStr;
    }
  }
}

function renderProgrammheft() {
  const container = document.getElementById("programmheft-list");
  if (!container) return;

  if (eventsData.length === 0) {
    container.innerHTML = `<div class="empty">Keine Events vorhanden.</div>`;
    return;
  }

  container.innerHTML = eventsData
    .map((ev) => {
      const rows = [];
      PEOPLE_ROLES.forEach((r) => {
        (ev[r.key] || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => {
          const entry = programmheftData.find((p) => p.name === name);
          const hasBio = !!(entry && entry.bio);
          const hasPhoto = !!(entry && entry.photoUrl);
          const rowIdx = entry ? entry.rowIndex : "";
          rows.push(`<div class="ph-person-row">
            <div class="ph-person-main">
              <div class="ph-person-name">${escapeHtml(name)}</div>
              <div class="ph-person-role">${escapeHtml(r.label)}</div>
            </div>
            <span class="ph-badge ${hasBio ? "ok" : "missing"}" ${hasBio ? `data-bio-row="${rowIdx}"` : ""}>Bio: ${hasBio ? "vorhanden" : "fehlt"}</span>
            <span class="ph-badge ${hasPhoto ? "ok" : "missing"}" ${hasPhoto ? `data-photo-row="${rowIdx}"` : ""}>Foto: ${hasPhoto ? "vorhanden" : "fehlt"}</span>
            <button type="button" class="ph-link-btn" data-ph-link="${rowIdx}" title="Formular-Link kopieren"><i class="ti ti-link"></i></button>
          </div>`);
        });
      });

      const peopleBody = rows.length
        ? rows.join("")
        : `<div class="empty">Noch keine Beteiligten bei diesem Event eingetragen.</div>`;

      return `<details class="ph-event-group">
        <summary class="ph-event-header">${escapeHtml(ev.project)} <span class="contract-count">${rows.length}</span></summary>
        <div class="ph-event-body">
          <div class="ph-subsection-title">Programmtext</div>
          <textarea class="programmtext-input" rows="5" placeholder="Programmtext für dieses Event…" data-row="${ev.rowIndex}">${escapeHtml(ev.programmtext || "")}</textarea>
          <div class="programmtext-actions">
            <span class="contract-status" id="pt-status-${ev.rowIndex}"></span>
            <button type="button" class="btn primary pt-save-btn" data-row="${ev.rowIndex}">Text speichern</button>
          </div>

          <div class="ph-subsection-title ph-subsection-spaced">Beteiligte</div>
          ${peopleBody}
        </div>
      </details>`;
    })
    .join("");

  container.querySelectorAll(".pt-save-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rowIndex = parseInt(btn.dataset.row, 10);
      const textarea = container.querySelector(`.programmtext-input[data-row="${rowIndex}"]`);
      saveProgrammtext(rowIndex, textarea.value);
    });
  });

  container.querySelectorAll("[data-bio-row]").forEach((el) => {
    el.addEventListener("click", () => openBioModal(parseInt(el.dataset.bioRow, 10)));
  });

  container.querySelectorAll("[data-photo-row]").forEach((el) => {
    el.addEventListener("click", () => {
      const entry = programmheftData.find((p) => p.rowIndex === parseInt(el.dataset.photoRow, 10));
      if (entry && entry.photoUrl) window.open(entry.photoUrl, "_blank", "noopener");
    });
  });

  container.querySelectorAll("[data-ph-link]").forEach((btn) => {
    btn.addEventListener("click", () => copyProgrammheftLink(parseInt(btn.dataset.phLink, 10)));
  });
}

function openBioModal(rowIndex) {
  const entry = programmheftData.find((p) => p.rowIndex === rowIndex);
  if (!entry) return;
  document.getElementById("bio-modal-title").textContent = entry.name;
  const photoEl = document.getElementById("bio-modal-photo");
  photoEl.innerHTML = entry.photoUrl
    ? `<a href="${escapeHtml(entry.photoUrl)}" target="_blank" rel="noopener">Foto in Drive öffnen</a>`
    : "";
  document.getElementById("bio-modal-text").textContent = entry.bio || "Keine Bio hinterlegt.";
  document.getElementById("bio-modal").classList.remove("hidden");
}

function closeBioModal() {
  document.getElementById("bio-modal").classList.add("hidden");
}

async function copyProgrammheftLink(rowIndex) {
  const entry = programmheftData.find((p) => p.rowIndex === rowIndex);
  if (!entry) return;

  if (!entry.token) {
    const newToken = genToken();
    const range = programmheftSheetRange(`G${rowIndex}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?valueInputOption=RAW`;
    try {
      await apiFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[newToken]] }),
      });
      entry.token = newToken;
    } catch (e) {
      setStatus("Zugriffsschlüssel konnte nicht erzeugt werden: " + e.message, true);
      return;
    }
  }

  const link = `${CONFIG.PROGRAMMHEFT_FORM_URL}?row=${entry.rowIndex}&token=${encodeURIComponent(entry.token)}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus(`Link für ${entry.name} kopiert — einfach einfügen und verschicken.`);
  } catch (e) {
    window.prompt("Link kopieren (Strg+C):", link);
  }
}

async function saveProgrammtext(rowIndex, value) {
  const statusEl = document.getElementById(`pt-status-${rowIndex}`);
  const ev = eventsData.find((e) => e.rowIndex === rowIndex);
  if (!ev) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${eventsSheetRange(`R${rowIndex}`)}?valueInputOption=RAW`;
  try {
    if (statusEl) statusEl.textContent = "Wird gespeichert…";
    await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[value]] }),
    });
    ev.programmtext = value;
    if (statusEl) statusEl.textContent = "Gespeichert.";
  } catch (e) {
    if (statusEl) statusEl.textContent = "Fehler beim Speichern: " + e.message;
  }
}

// ---------- Termin-Detailansicht ----------

function findLoadedEvent(eventId) {
  return lastLoadedEvents.find((ev) => ev.id === eventId);
}

function extractZoomLink(description) {
  if (!description) return null;
  const match = description.match(/https?:\/\/[^\s]*zoom[^\s]*/i);
  return match ? match[0] : null;
}

function openTerminModal(eventId) {
  const ev = findLoadedEvent(eventId);
  if (!ev) return;

  document.getElementById("termin-modal-title").textContent = ev.summary || "(ohne Titel)";

  const rows = [];

  // Zeitpunkt
  if (ev.start.dateTime) {
    const start = new Date(ev.start.dateTime);
    const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
    const dateStr = start.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    const timeStr = start.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      + (end ? " – " + end.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "");
    rows.push({ icon: "calendar-event", label: "Wann", value: `${dateStr}<br>${timeStr}` });
  } else {
    const start = new Date(ev.start.date + "T00:00:00");
    rows.push({
      icon: "calendar-event",
      label: "Wann",
      value: start.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) + " (ganztägig)",
    });
  }

  const cat = categoryOf(ev);
  if (cat) rows.push({ icon: "tag", label: "Kategorie", value: escapeHtml(cat) });
  if (isDeadlineEvent(ev)) rows.push({ icon: "alarm", label: "Typ", value: "Aufgaben-Deadline" });

  if (ev.location) rows.push({ icon: "map-pin", label: "Ort", value: escapeHtml(ev.location) });

  const zoom = extractZoomLink(ev.description) || ev.hangoutLink;
  if (zoom) {
    rows.push({
      icon: "video",
      label: "Video",
      value: `<a href="${escapeHtml(zoom)}" target="_blank" rel="noopener">Meeting beitreten</a>`,
    });
  }

  if (ev.attendees && ev.attendees.length) {
    const list = ev.attendees
      .map((a) => {
        const name = a.displayName || a.email;
        const statusMap = { accepted: "zugesagt", declined: "abgesagt", tentative: "vorläufig", needsAction: "offen" };
        return `<div class="termin-attendee">${escapeHtml(name)} <span class="termin-attendee-status">${statusMap[a.responseStatus] || ""}</span></div>`;
      })
      .join("");
    rows.push({ icon: "users", label: "Teilnehmende", value: list });
  }

  if (ev.description) {
    // Zoom-Zeile nicht doppelt anzeigen
    const descWithoutZoom = ev.description.replace(/Zoom:\s*https?:\/\/[^\s]*/i, "").trim();
    if (descWithoutZoom) {
      rows.push({ icon: "note", label: "Notizen", value: escapeHtml(descWithoutZoom).replace(/\n/g, "<br>") });
    }
  }

  document.getElementById("termin-modal-body").innerHTML = rows
    .map(
      (r) => `<div class="termin-row">
        <div class="termin-row-label"><i class="ti ti-${r.icon}"></i> ${r.label}</div>
        <div class="termin-row-value">${r.value}</div>
      </div>`
    )
    .join("");

  const gcalLink = document.getElementById("termin-gcal-link");
  gcalLink.href = ev.htmlLink || "#";
  gcalLink.style.display = ev.htmlLink ? "" : "none";

  currentTerminId = eventId;
  // Automatische Deadlines lassen sich nicht einzeln löschen — die steuert
  // die Aufgabenliste, ein manuelles Löschen würde beim nächsten Sync
  // ohnehin wieder rückgängig gemacht.
  const delBtn = document.getElementById("termin-delete-btn");
  if (delBtn) delBtn.style.display = isDeadlineEvent(ev) ? "none" : "";

  document.getElementById("termin-modal").classList.remove("hidden");
}

function closeTerminModal() {
  document.getElementById("termin-modal").classList.add("hidden");
  currentTerminId = null;
}

let currentTerminId = null;

async function deleteTermin() {
  if (!currentTerminId) return;
  const ev = findLoadedEvent(currentTerminId);
  if (!ev) return;

  if (isDeadlineEvent(ev)) {
    setStatus("Das ist eine automatische Aufgaben-Deadline — sie verschwindet, sobald die Aufgabe erledigt oder gelöscht ist.", true);
    return;
  }

  const titel = ev.summary || "(ohne Titel)";
  if (!window.confirm(`Termin "${titel}" wirklich löschen? Das lässt sich nicht rückgängig machen.`)) return;

  const calId = encodeURIComponent(CONFIG.CALENDAR_ID);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(currentTerminId)}?sendUpdates=all`;
  try {
    await apiFetch(url, { method: "DELETE" });
    closeTerminModal();
    setStatus("Termin gelöscht.");
    await loadCalendar();
    renderDashboard();
  } catch (e) {
    setStatus("Termin konnte nicht gelöscht werden: " + e.message, true);
  }
}

// Teilnehmer-Auswahl im Formular aus den Stammdaten befüllen
function fillAttendeeSelect() {
  const sel = document.getElementById("event-attendees-select");
  if (!sel) return;
  const withEmail = peopleList.filter((p) => p.email);
  sel.innerHTML = withEmail
    .map((p) => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name)}</option>`)
    .join("");
  if (withEmail.length === 0) {
    sel.innerHTML = `<option value="" disabled>Keine E-Mail-Adressen in den Stammdaten hinterlegt</option>`;
  }
}

// Nächsten anstehenden Termin fürs Dashboard rendern
function renderNextEvent() {
  const container = document.getElementById("dashboard-next-event");
  if (!container) return;

  const now = new Date();
  const upcoming = (lastCalendarEvents || [])
    .filter((ev) => !isDeadlineEvent(ev))
    .map((ev) => ({ ev, when: new Date(ev.start.dateTime || ev.start.date + "T00:00:00") }))
    .filter((x) => x.when >= new Date(now.toDateString()))
    .sort((a, b) => a.when - b.when);

  if (upcoming.length === 0) {
    container.innerHTML = "";
    return;
  }

  const { ev, when } = upcoming[0];
  const cat = categoryOf(ev);
  const catClass = cat ? `is-${EVENT_CATEGORIES[cat].cls}` : "is-event";
  const dateStr = when.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
  const timeStr = ev.start.dateTime
    ? when.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr"
    : "ganztägig";

  container.innerHTML = `<div class="next-event-card ${catClass}" data-next-event-id="${escapeHtml(ev.id)}">
    <div class="next-event-label">Nächster Termin</div>
    <div class="next-event-title">${escapeHtml(ev.summary || "(ohne Titel)")}</div>
    <div class="next-event-meta">${dateStr} · ${timeStr}${ev.location ? " · " + escapeHtml(ev.location) : ""}</div>
  </div>`;

  const card = container.querySelector("[data-next-event-id]");
  if (card) {
    card.addEventListener("click", () => {
      lastLoadedEvents = lastCalendarEvents;
      openTerminModal(ev.id);
    });
  }
}
