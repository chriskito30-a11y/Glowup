import { enforceModuleAccess, logoutFromModule } from "./modulys-access.js";
import {
  $,
  $$,
  MODULE_ID,
  listenSession,
  launchEffect,
  closeSession,
  sessionUrl,
  qrUrl,
  currentEffectPayload,
  normalizePlacementConfig,
  targetLabel
} from "./core.js";

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
let currentSession = null;
let currentColor = "#ffffff";
let sequenceTimers = [];

function setStatus(message = "", type = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`.trim();
}

function getTarget() {
  return {
    zone: $("#zoneSelect")?.value || "all",
    depth: $("#depthSelect")?.value || "all",
    row: $("#rowSelect")?.value || "all"
  };
}

function populateRows(session) {
  const rowSelect = $("#rowSelect");
  if (!rowSelect) return;
  const previous = rowSelect.value || "all";
  const config = normalizePlacementConfig(session?.placementConfig || {});
  rowSelect.innerHTML = `<option value="all">Toutes les rangées</option>`;
  if (config.rowsEnabled) {
    const count = config.rowCount || 80;
    for (let i = 1; i <= count; i += 1) rowSelect.insertAdjacentHTML("beforeend", `<option value="${i}">Rangée ${i}</option>`);
  }
  rowSelect.disabled = !config.rowsEnabled;
  if ([...rowSelect.options].some(option => option.value === previous)) rowSelect.value = previous;
}

function renderPlacementSummary(session) {
  const config = normalizePlacementConfig(session?.placementConfig || {});
  const parts = ["Gauche / centre / droite"];
  if (config.depthEnabled) parts.push("Devant / milieu / derrière");
  if (config.rowsEnabled) parts.push(`${config.rowCount || "?"} rangée(s)`);
  const el = $("#placementSummary");
  if (el) el.innerHTML = `<strong>Placement :</strong> ${parts.join(" · ")}`;
}

function render(session) {
  currentSession = session;
  if (!session) {
    document.body.innerHTML = `<main class="access-screen"><section class="access-card"><h1>Session indisponible</h1><p>Cette session GlowUp est introuvable ou expirée.</p><a class="btn btn-primary" href="index.html">Retour</a></section></main>`;
    return;
  }
  $("#sessionTitle").textContent = session.title || "GlowUp";
  $("#sessionSubtitle").textContent = session.subtitle || "Le public devient la lumière du spectacle.";
  $("#participantCount").textContent = Object.keys(session.participants || {}).length;
  $("#participantLimit").textContent = session.participantsLimit || "—";
  $("#sessionState").textContent = session.status === "closed" ? "Fermée" : "Ouverte";
  const url = sessionUrl(sessionId);
  $("#joinLink").value = url;
  $("#qrImg").src = qrUrl(url);
  populateRows(session);
  renderPlacementSummary(session);
}

async function boot() {
  if (!sessionId) return render(null);
  const result = await enforceModuleAccess(MODULE_ID, { mode: "hard" });
  if (!result.ok) return;
  listenSession(sessionId, render);
}

function effectPayload(type, label) {
  const target = getTarget();
  const color = type === "idle" ? "#111827" : currentColor;
  return currentEffectPayload(type, { color, target, label });
}

async function sendEffect(type, label) {
  await launchEffect(sessionId, effectPayload(type, label));
  setStatus(`Effet envoyé : ${targetLabel(getTarget())}.`, "success");
}

$$(".color-btn").forEach(btn => btn.addEventListener("click", async () => {
  currentColor = btn.dataset.color || "#ffffff";
  await sendEffect("color", "Couleur");
}));

$$("[data-effect]").forEach(btn => btn.addEventListener("click", async () => {
  await sendEffect(btn.dataset.effect, btn.textContent.trim());
}));

function sequenceTargets(mode) {
  const config = normalizePlacementConfig(currentSession?.placementConfig || {});
  if (mode === "left-center-right") return ["left", "center", "right"].map(zone => ({ zone, depth: "all", row: "all" }));
  if (mode === "right-center-left") return ["right", "center", "left"].map(zone => ({ zone, depth: "all", row: "all" }));
  if (mode === "front-middle-back") return ["front", "middle", "back"].map(depth => ({ zone: "all", depth, row: "all" }));
  if (mode === "back-middle-front") return ["back", "middle", "front"].map(depth => ({ zone: "all", depth, row: "all" }));
  if (mode === "rows-forward" || mode === "rows-backward") {
    if (!config.rowsEnabled) throw new Error("Les rangées ne sont pas activées pour cette session.");
    const rows = Array.from({ length: config.rowCount || 0 }, (_, index) => String(index + 1));
    if (mode === "rows-backward") rows.reverse();
    return rows.map(row => ({ zone: "all", depth: "all", row }));
  }
  return [{ zone: "all", depth: "all", row: "all" }];
}

$("#sequenceBtn")?.addEventListener("click", async () => {
  try {
    sequenceTimers.forEach(timer => clearTimeout(timer));
    sequenceTimers = [];
    const mode = $("#sequenceMode").value;
    const delay = Math.max(250, Math.min(3000, Number($("#sequenceDelay").value || 700)));
    const targets = sequenceTargets(mode);
    const baseColor = currentColor;
    targets.forEach((target, index) => {
      const timer = window.setTimeout(() => {
        launchEffect(sessionId, currentEffectPayload("color", {
          color: baseColor,
          target,
          durationMs: delay,
          label: `Séquence ${index + 1}/${targets.length}`
        })).catch(console.warn);
      }, index * delay);
      sequenceTimers.push(timer);
    });
    const stopTimer = window.setTimeout(() => {
      launchEffect(sessionId, currentEffectPayload("idle", { color: "#111827", label: "Repos" })).catch(console.warn);
    }, targets.length * delay + 250);
    sequenceTimers.push(stopTimer);
    setStatus(`Séquence lancée : ${targets.length} étape(s).`, "success");
  } catch (error) {
    setStatus(error.message || "Impossible de lancer la séquence.", "error");
  }
});

$("#copyBtn")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#joinLink").value);
  setStatus("Lien copié.", "success");
});

$("#closeBtn")?.addEventListener("click", async () => {
  if (confirm("Fermer cette session GlowUp ?")) {
    await closeSession(sessionId);
    setStatus("Session fermée.", "success");
  }
});

$("#logoutBtn")?.addEventListener("click", () => logoutFromModule());
boot();
