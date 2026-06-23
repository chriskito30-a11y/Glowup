import {
  $,
  readSession,
  joinSession,
  listenSession,
  startHeartbeat,
  updateParticipantPlacement,
  normalizePlacementConfig,
  targetLabel
} from "./core.js";

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
let participantId = null;
let participant = { zone: "center", depth: "middle", row: "" };
let currentSession = null;
let heartbeat = null;
let currentEffect = null;

function setStatus(message = "", type = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`.trim();
}

function savedPlacement() {
  try { return JSON.parse(localStorage.getItem(`glowup:${sessionId}:placement`) || "{}"); }
  catch { return {}; }
}

function applySessionPlacementOptions(session) {
  const config = normalizePlacementConfig(session?.placementConfig || {});
  const depthField = $("#depthField");
  const rowField = $("#rowField");
  const rowInput = $("#rowInput");
  const saved = savedPlacement();

  if ($("#zoneSelect") && saved.zone) $("#zoneSelect").value = saved.zone;
  if ($("#depthSelect") && saved.depth) $("#depthSelect").value = saved.depth;

  if (depthField) depthField.hidden = !config.depthEnabled;
  if (rowField) rowField.hidden = !config.rowsEnabled;
  if (rowInput) {
    rowInput.max = String(config.rowCount || 80);
    rowInput.placeholder = config.rowCount ? `Entre 1 et ${config.rowCount}` : "Ex. 4";
    if (saved.row) rowInput.value = saved.row;
  }
}

function effectMatches(effect = {}) {
  const target = effect.target || { zone: effect.zone || "all", depth: "all", row: "all" };
  const zoneOk = !target.zone || target.zone === "all" || target.zone === participant.zone;
  const depthOk = !target.depth || target.depth === "all" || target.depth === participant.depth;
  const rowOk = !target.row || target.row === "all" || String(target.row) === String(participant.row || "");
  return zoneOk && depthOk && rowOk;
}

function placementText() {
  const parts = [];
  if (participant.zoneLabel) parts.push(participant.zoneLabel);
  if (participant.depthLabel) parts.push(participant.depthLabel);
  if (participant.row) parts.push(`rangée ${participant.row}`);
  return parts.length ? parts.join(" · ") : "placement non renseigné";
}

function placementPanelHtml() {
  const config = normalizePlacementConfig(currentSession?.placementConfig || {});
  const rowMax = config.rowCount || 80;
  return `<form id="placementPanel" class="placement-panel" aria-label="Modifier mon placement">
    <button class="placement-toggle" type="button" id="togglePlacementBtn">Modifier ma place</button>
    <div class="placement-fields" id="placementFields" hidden>
      <label>Position
        <select name="zone">
          <option value="left" ${participant.zone === "left" ? "selected" : ""}>Gauche</option>
          <option value="center" ${participant.zone === "center" ? "selected" : ""}>Centre</option>
          <option value="right" ${participant.zone === "right" ? "selected" : ""}>Droite</option>
        </select>
      </label>
      ${config.depthEnabled ? `<label>Profondeur
        <select name="depth">
          <option value="front" ${participant.depth === "front" ? "selected" : ""}>Devant</option>
          <option value="middle" ${participant.depth === "middle" ? "selected" : ""}>Milieu</option>
          <option value="back" ${participant.depth === "back" ? "selected" : ""}>Derrière</option>
        </select>
      </label>` : ""}
      ${config.rowsEnabled ? `<label>Rangée
        <input name="row" type="number" min="1" max="${rowMax}" inputmode="numeric" value="${participant.row || ""}" placeholder="1 à ${rowMax}">
      </label>` : ""}
      <button class="btn btn-secondary" type="submit">Mettre à jour</button>
    </div>
  </form>`;
}

function bindPlacementPanel() {
  const toggle = $("#togglePlacementBtn");
  const fields = $("#placementFields");
  const panel = $("#placementPanel");
  toggle?.addEventListener("click", () => { if (fields) fields.hidden = !fields.hidden; });
  panel?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!participantId) return;
    const form = event.currentTarget;
    try {
      participant = await updateParticipantPlacement(sessionId, participantId, {
        zone: form.zone.value,
        depth: form.depth?.value || participant.depth,
        row: form.row?.value || ""
      });
      applyEffect(currentEffect || currentSession?.currentEffect || {});
    } catch (error) {
      console.warn(error);
    }
  });
}

function applyEffect(effect = {}) {
  if (!participantId) return;
  currentEffect = effect;
  const type = effect.type || "idle";
  const matched = effectMatches(effect);
  const color = matched ? (effect.color || "#111827") : "#111827";
  const target = effect.target || { zone: effect.zone || "all" };
  let content = `<div class="participant-meta">${placementText()}</div>
    <div class="hint">Gardez cette page ouverte. Vous faites partie du show ✨<br><small>Effet ciblé : ${targetLabel(target)}</small></div>
    ${placementPanelHtml()}`;

  if (type === "countdown" && matched) {
    const elapsed = Date.now() - Number(effect.startedAt || Date.now());
    const left = Math.max(1, 3 - Math.floor(elapsed / 1000));
    content = `<div class="countdown">${left}</div>
      <div class="participant-meta">${placementText()}</div>
      <div class="hint">Compte à rebours GlowUp</div>
      ${placementPanelHtml()}`;
  }

  document.body.className = "";
  document.body.innerHTML = `<main class="light-stage ${matched ? type : "idle"}">${content}</main>`;
  const stage = document.querySelector(".light-stage");
  if (stage) stage.style.background = (type === "idle" || !matched) ? "#111827" : color;
  bindPlacementPanel();
}

async function boot() {
  if (!sessionId) {
    setStatus("Lien GlowUp incomplet.", "error");
    return;
  }
  try {
    const session = await readSession(sessionId);
    if (!session || session.expiresAt <= Date.now() || session.status === "closed") throw new Error("Session GlowUp expirée ou indisponible.");
    currentSession = session;
    $("#joinTitle").textContent = session.title || "Rejoindre GlowUp";
    $("#joinSubtitle").textContent = session.subtitle || "Le public devient la lumière du spectacle.";
    applySessionPlacementOptions(session);
  } catch (error) {
    setStatus(error.message || "Session indisponible.", "error");
  }
}

$("#joinForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus("Connexion au show…");
  try {
    const result = await joinSession(sessionId, {
      name: form.name.value.trim() || "Participant",
      zone: form.zone.value,
      depth: form.depth?.value || "middle",
      row: form.row?.value || ""
    });
    participantId = result.participantId;
    participant = result.participant;
    heartbeat = startHeartbeat(sessionId, participantId);
    listenSession(sessionId, session => {
      currentSession = session;
      if (!session || session.status === "closed") {
        document.body.innerHTML = `<main class="light-stage"><div class="hint">Session terminée. Merci d’avoir participé ✨</div></main>`;
        if (heartbeat) clearInterval(heartbeat);
        return;
      }
      applyEffect(session.currentEffect);
    });
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  } catch (error) {
    setStatus(error.message || "Impossible de rejoindre cette session.", "error");
  }
});

boot();
