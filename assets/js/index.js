import { enforceModuleAccess, logoutFromModule, renderFreeLimitUpgrade, isFreeLimitError } from "./modulys-access.js";
import { $, escapeHtml, createSession, listOwnerSessions, MODULE_ID } from "./core.js";

let currentUser = null;
let currentAccess = null;

function setStatus(message = "", type = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`.trim();
}

async function loadSessions() {
  const sessions = await listOwnerSessions(currentUser);
  const list = $("#sessionsList");
  if (!sessions.length) {
    list.innerHTML = `<article class="empty-card"><strong>Aucune session pour le moment</strong><span>Créez votre premier show lumineux.</span></article>`;
    return;
  }
  list.innerHTML = sessions.map(([id, s]) => `<article class="session-card">
    <div>
      <strong>${escapeHtml(s.title || id)}</strong>
      <span>${escapeHtml(s.subtitle || "Show lumineux")} · ${Number(s.stats?.participantsCount || Object.keys(s.participants || {}).length || 0)} connecté(s)</span>
    </div>
    <a class="btn btn-secondary" href="session.html?session=${escapeHtml(id)}">Gérer</a>
  </article>`).join("");
}

function bindPlacementOptions() {
  const rowsEnabled = $("#rowsEnabled");
  const rowCountField = $("#rowCountField");
  if (!rowsEnabled || !rowCountField) return;
  const refresh = () => { rowCountField.hidden = !rowsEnabled.checked; };
  rowsEnabled.addEventListener("change", refresh);
  refresh();
}

async function boot() {
  bindPlacementOptions();
  const result = await enforceModuleAccess(MODULE_ID, { mode: "hard" });
  if (!result.ok) return;
  currentUser = result.user;
  currentAccess = result.access;
  $("#userEmail").textContent = currentUser?.email || "Compte connecté";
  $("#planLabel").textContent = currentAccess?.plan?.name || (currentAccess?.unlimited ? "Administrateur" : "Offre Découverte");
  await loadSessions();
}

$("#createForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus("Création de la session…");
  try {
    const { sessionId } = await createSession({
      user: currentUser,
      access: currentAccess,
      title: form.title.value.trim(),
      subtitle: form.subtitle.value.trim(),
      eventDate: form.eventDate.value,
      warningAccepted: form.warningAccepted.checked,
      depthEnabled: form.depthEnabled.checked,
      rowsEnabled: form.rowsEnabled.checked,
      rowCount: form.rowCount.value
    });
    location.href = `session.html?session=${encodeURIComponent(sessionId)}`;
  } catch (error) {
    console.warn(error);
    if (isFreeLimitError(error)) {
      renderFreeLimitUpgrade("#limitBox", MODULE_ID, error);
      setStatus("");
      return;
    }
    setStatus(friendlyErrorMessage(error, "Impossible de créer l’animation."), "error");
  }
});

$("#logoutBtn")?.addEventListener("click", () => logoutFromModule());
boot();
