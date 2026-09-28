const state = {
  csrfToken: "",
  groups: [],
  documents: [],
  editingGroupId: null,
};
const $ = (selector) => document.querySelector(selector);
const runSequentialQueue = window.RagIngestionQueue?.runSequentialQueue;

function setStatus(message, good = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("good", good);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-VoiceConnect-RAG-Portal", "1");
  if (!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase())) {
    if (!state.csrfToken) throw new Error("Sign in to Voice Connect to manage your library.");
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  if (options.body && !(options.body instanceof FormData) && !options.rawBody) headers.set("Content-Type", "application/json");
  const { rawBody: _rawBody, ...fetchOptions } = options;
  const response = await fetch(path, { ...fetchOptions, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
  return data;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value ?? "";
  return element.innerHTML;
}

function showGroupResult(message, kind = "info") {
  const result = $("#group-result");
  result.textContent = message;
  result.dataset.kind = kind;
}

function resetGroupForm() {
  state.editingGroupId = null;
  $("#group-form").reset();
  $("#create-group").textContent = "Create group";
  $("#cancel-group-edit").hidden = true;
}

function beginGroupEdit(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  if (group.system_key) {
    showGroupResult("System-managed groups cannot be edited here.", "error");
    return;
  }
  state.editingGroupId = group.id;
  const form = $("#group-form");
  form.elements.name.value = group.name;
  form.elements.aliases.value = (group.aliases || []).join(", ");
  form.elements.description.value = group.description || "";
  $("#create-group").textContent = "Save changes";
  $("#cancel-group-edit").hidden = false;
  showGroupResult(`Editing “${group.name}”. Its stable slug will remain “${group.slug}”.`, "info");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  form.elements.name.focus({ preventScroll: true });
}

function focusGroup(slug) {
  if (!slug) return;
  $("#upload-group").value = slug;
  const card = [...$("#groups").querySelectorAll("[data-group-slug]")]
    .find((item) => item.dataset.groupSlug === slug);
  if (!card) return;
  card.classList.add("created");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => card.classList.remove("created"), 5000);
}

async function loadGroups(focusSlug = "") {
  state.groups = await api("/v1/groups");
  const displayedGroups = focusSlug
    ? [...state.groups].sort((a, b) => Number(b.slug === focusSlug) - Number(a.slug === focusSlug))
    : state.groups;
  $("#groups").classList.toggle("empty", !state.groups.length);
  $("#groups").innerHTML = state.groups.length
    ? displayedGroups.map((group) => `
      <article data-group-slug="${escapeHtml(group.slug)}">
        <div class="group-card-head">
          <div class="group-identity">
            <strong>${escapeHtml(group.name)}</strong>
            <code>${escapeHtml(group.slug)}</code>
          </div>
          <div class="group-card-actions">
            ${group.system_key
              ? '<span class="system-badge">System</span>'
              : `<button class="quiet edit-group" type="button" data-group-id="${escapeHtml(group.id)}">Edit</button>`}
          </div>
        </div>
        <p>${escapeHtml(group.description || "No routing description")}</p>
        <small>${escapeHtml((group.aliases || []).length ? `Aliases: ${group.aliases.join(", ")}` : "No aliases")}</small>
      </article>`).join("")
    : "No groups yet.";
  for (const selector of ["#upload-group", "#search-group"]) {
    const select = $(selector);
    const first = selector === "#search-group" ? '<option value="">Choose intelligently</option>' : '<option value="">Select a group</option>';
    select.innerHTML = first + state.groups.map((group) => `<option value="${escapeHtml(group.slug)}">${escapeHtml(group.name)}</option>`).join("");
  }
  focusGroup(focusSlug);
}

async function loadDocuments() {
  state.documents = await api("/v1/documents?limit=100");
  const visibleChunks = state.documents.reduce((total, doc) => total + Number(doc.chunk_count || 0), 0);
  $("#documents-summary").textContent = state.documents.length
    ? `Showing ${state.documents.length.toLocaleString()} ${state.documents.length === 1 ? "document" : "documents"} · ${visibleChunks.toLocaleString()} ${visibleChunks === 1 ? "chunk" : "chunks"}`
    : "";
  $("#documents").classList.toggle("empty", !state.documents.length);
  $("#documents").innerHTML = state.documents.length ? state.documents.map((doc) => `
    <article class="document">
      <div><strong>${escapeHtml(doc.title || doc.filename)}</strong><span>${escapeHtml(doc.group_name || doc.group_slug || "Unknown group")} · ${doc.created_by_agent ? "Agent-created" : "Uploaded source"} · ${Number(doc.chunk_count || 0).toLocaleString()} ${Number(doc.chunk_count || 0) === 1 ? "chunk" : "chunks"}</span>${doc.title && doc.title !== doc.filename ? `<small>${escapeHtml(doc.filename)}</small>` : ""}${doc.error ? `<small class="document-error">${escapeHtml(doc.error)}</small>` : ""}</div>
      <span class="pill ${escapeHtml(doc.status)}">${escapeHtml(doc.status)}</span>
      <div class="document-actions">
        <button class="quiet download" type="button" data-id="${escapeHtml(doc.id)}" ${doc.status !== "ready" ? "disabled" : ""}>Download</button>
        <button class="quiet danger delete-document" type="button" data-id="${escapeHtml(doc.id)}">Delete</button>
      </div>
    </article>`).join("") : "No documents yet.";
}

function pause(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForIngestion(accepted, onStatus) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await api(`/v1/jobs/${accepted.job_id}`);
    onStatus(job);
    if (job.status === "completed" || job.status === "failed") return job;
    await pause(1000);
  }
  throw new Error("Ingestion status could not be confirmed after ten minutes. This source was skipped and the queue continued with the next source.");
}

function renderIngestionQueue(queue) {
  const list = $("#ingestion-queue");
  list.hidden = false;
  list.innerHTML = queue.map((item) => `
    <li data-state="${escapeHtml(item.status)}">
      <span class="queue-marker" aria-hidden="true"></span>
      <span class="queue-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <span class="queue-state">${escapeHtml(item.detail)}</span>
    </li>`).join("");
}

function showIngestionProgress(title, source, detail, finished = false, warning = false) {
  const progress = $("#ingestion-progress");
  progress.hidden = false;
  progress.classList.toggle("complete", finished);
  progress.classList.toggle("warning", warning);
  $("#processing-title").textContent = title;
  $("#processing-source").textContent = source;
  $("#processing-count").textContent = detail;
  $(".processing-complete").textContent = warning ? "!" : "✓";
}

function setUploadControlsBusy(busy) {
  for (const control of $("#upload-form").elements) control.disabled = busy;
}

function updateFileSelection() {
  const files = Array.from($("#upload-file").files);
  $("#file-selection").textContent = files.length
    ? `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"} selected: ${files.map((file) => file.name).join(", ")}`
    : "Select one or more files. They will be ingested one at a time.";
}

async function connectWithVoiceConnect() {
  try {
    const response = await fetch("/api/status", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.authenticated !== true) {
      throw new Error("Your session has expired. Return to Voice Connect and sign in again.");
    }
    if (body.authenticated !== true) throw new Error("The Voice Connect session has expired.");
    state.csrfToken = String(body.csrfToken || "");
    if (!state.csrfToken) throw new Error("Voice Connect did not provide the required security token.");
    await Promise.all([loadGroups(), loadDocuments()]);
    setStatus("Connected", true);
  } catch (error) {
    setStatus(error.message);
  }
}

$("#refresh-groups").addEventListener("click", () => loadGroups().catch((error) => setStatus(error.message)));
$("#refresh-documents").addEventListener("click", () => loadDocuments().catch((error) => setStatus(error.message)));
$("#upload-file").addEventListener("change", updateFileSelection);
$("#cancel-group-edit").addEventListener("click", () => {
  resetGroupForm();
  showGroupResult("Edit cancelled.", "info");
});
$("#groups").addEventListener("click", (event) => {
  const button = event.target.closest(".edit-group");
  if (button) beginGroupEdit(button.dataset.groupId);
});

$("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const name = String(form.get("name") || "").trim();
  const button = $("#create-group");
  const editingGroup = state.groups.find((group) => group.id === state.editingGroupId);
  const existing = state.groups.find((group) =>
    group.id !== state.editingGroupId &&
    group.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (existing) {
    await loadGroups(existing.slug);
    showGroupResult(`“${existing.name}” already exists. It is highlighted below and selected for ingestion.`, "info");
    setStatus("Group already exists", true);
    return;
  }
  button.disabled = true;
  button.textContent = editingGroup ? "Saving…" : "Creating…";
  showGroupResult(
    editingGroup
      ? "Saving group metadata and refreshing affected document views…"
      : "Creating group and refreshing the list…",
    "info",
  );
  try {
    const saved = await api(
      editingGroup ? `/v1/groups/${editingGroup.id}` : "/v1/groups",
      {
      method: editingGroup ? "PATCH" : "POST",
      body: JSON.stringify({
        name,
        aliases: String(form.get("aliases") || "").split(",").map((v) => v.trim()).filter(Boolean),
        description: form.get("description") || "",
      }),
    });
    resetGroupForm();
    await Promise.all([loadGroups(saved.slug), loadDocuments()]);
    showGroupResult(
      editingGroup
        ? `Updated “${saved.name}”. Existing documents and automatic routing now use the corrected metadata.`
        : `Created “${saved.name}”. It is highlighted below and selected for ingestion.`,
      "success",
    );
    setStatus(editingGroup ? "Group updated" : "Group created", true);
  } catch (error) {
    await loadGroups().catch(() => {});
    const nowExisting = state.groups.find((group) =>
      group.id !== state.editingGroupId &&
      group.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (nowExisting) {
      await loadGroups(nowExisting.slug);
      showGroupResult(`“${nowExisting.name}” already exists. It is highlighted below and selected for ingestion.`, "info");
      setStatus("Group already exists", true);
    } else {
      showGroupResult(`Could not ${editingGroup ? "update" : "create"} the group: ${error.message}`, "error");
      setStatus(error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = state.editingGroupId ? "Save changes" : "Create group";
  }
});

$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const files = Array.from($("#upload-file").files);
  const url = $("#upload-url").value.trim();
  if ((files.length && url) || (!files.length && !url)) {
    const message = "Choose one source mode: one or more document files, or one public URL.";
    $("#upload-result").textContent = message;
    setStatus(message);
    return;
  }
  const selectedGroup = String(form.get("group") || "");
  const processingMode = String(form.get("processing_mode") || "automatic");
  const button = $("#ingest-source");
  const queue = files.length
    ? files.map((file) => ({ kind: "file", file, name: file.name, status: "waiting", detail: "Waiting" }))
    : [{ kind: "url", url, name: url, status: "waiting", detail: "Waiting" }];
  let completed = 0;
  const failures = [];
  let refreshError = null;
  setUploadControlsBusy(true);
  button.textContent = `Processing 1 of ${queue.length}…`;
  renderIngestionQueue(queue);
  showIngestionProgress("Starting ingestion queue…", queue[0].name, `Source 1 of ${queue.length}`);
  $("#upload-result").textContent = `Processing ${queue.length} ${queue.length === 1 ? "source" : "sources"} one at a time…`;
  try {
    if (!runSequentialQueue) throw new Error("The ingestion queue did not load. Refresh this page before trying again.");
    await runSequentialQueue(queue, async (item, index) => {
      let accepted = null;
      let terminalReached = false;
      item.status = "uploading";
      item.detail = item.kind === "url" ? "Fetching" : "Uploading";
      renderIngestionQueue(queue);
      button.textContent = `Processing ${index + 1} of ${queue.length}…`;
      showIngestionProgress(
        item.kind === "url" ? "Fetching public URL…" : "Uploading file…",
        item.name,
        `Source ${index + 1} of ${queue.length}`,
      );
      try {
        if (item.kind === "url") {
          accepted = await api("/v1/ingest/url", {
            method: "POST",
            body: JSON.stringify({ group: selectedGroup, url: item.url, processing_mode: processingMode }),
          });
        } else {
          const query = new URLSearchParams({
            group: selectedGroup,
            filename: item.file.name,
            processing_mode: processingMode,
          });
          accepted = await api(`/v1/ingest/raw?${query}`, {
            method: "POST",
            body: item.file,
            rawBody: true,
            headers: { "Content-Type": item.file.type || "application/octet-stream" },
          });
        }
        item.status = "processing";
        item.detail = accepted.retried ? "Retrying" : "Processing";
        $("#upload-result").textContent = accepted.retried
          ? `Previous failure found; retry queued.\n${item.name}`
          : `Source accepted.\n${item.name}`;
        renderIngestionQueue(queue);
        const job = await waitForIngestion(accepted, (currentJob) => {
          item.detail = currentJob.status === "queued" ? "Queued" : "Processing";
          renderIngestionQueue(queue);
          showIngestionProgress(
            currentJob.status === "queued"
              ? "Waiting for the RAG worker…"
              : processingMode === "automatic"
                ? "Extracting, chunking, and embedding…"
                : "Enhanced AI is transcribing, chunking, and embedding…",
            item.name,
            `Source ${index + 1} of ${queue.length} · ${currentJob.status}`,
          );
        });
        terminalReached = true;
        if (job.status === "failed") throw new Error(job.error || "Document ingestion failed");
        completed += 1;
        item.status = "completed";
        item.detail = accepted.duplicate ? "Already indexed" : "Completed";
      } catch (error) {
        item.status = "failed";
        item.detail = accepted && !terminalReached ? "Status unknown · skipped" : "Skipped";
        failures.push({ name: item.name, message: error.message });
        throw error;
      } finally {
        renderIngestionQueue(queue);
        await loadDocuments().then(() => { refreshError = null; }).catch((error) => { refreshError = error; });
      }
    });

    await loadDocuments().then(() => { refreshError = null; }).catch((error) => { refreshError = error; });

    formElement.reset();
    $("#upload-group").value = selectedGroup;
    updateFileSelection();
    const summary = `${queue.length} attempted · ${completed} completed · ${failures.length} skipped`;
    const hasWarnings = Boolean(failures.length || refreshError);
    showIngestionProgress(
      hasWarnings ? "Ingestion queue finished with an issue" : "Ingestion queue complete",
      failures.length ? failures[0].name : refreshError ? "Document list refresh failed" : "All selected sources are ready",
      summary,
      true,
      hasWarnings,
    );
    $("#upload-result").textContent = [
      summary,
      ...failures.map((failure) => `${failure.name}: ${failure.message}`),
      ...(refreshError ? [`Documents were ingested, but chunk counts could not be refreshed: ${refreshError.message}`] : []),
    ].join("\n");
    setStatus(hasWarnings ? "Ingestion queue needs attention" : "Documents ingested", !hasWarnings);
  } catch (error) {
    $("#upload-result").textContent = error.message;
    setStatus(error.message);
    showIngestionProgress("Ingestion queue stopped", "", error.message, true, true);
    await loadDocuments().catch(() => {});
  } finally {
    setUploadControlsBusy(false);
    button.textContent = "Ingest selected sources";
  }
});

$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#results").textContent = "Searching…";
  try {
    const body = { query: form.get("query"), limit: 8 };
    if (form.get("group")) body.group = form.get("group");
    const result = await api("/v1/search", { method: "POST", body: JSON.stringify(body) });
    $("#routing").textContent = `${result.routing_reason}: ${result.searched_groups.map((g) => g.name).join(" + ")}`;
    $("#results").classList.toggle("empty", !result.hits.length);
    $("#results").innerHTML = result.hits.length ? result.hits.map((hit) => `
      <article class="hit">
        <div><strong>${escapeHtml(hit.filename)}</strong><span>${escapeHtml(hit.group_name)} · chunk ${hit.chunk_index + 1}</span></div>
        <p>${escapeHtml(hit.content)}</p>
        <small>RRF score ${Number(hit.score).toFixed(5)}</small>
      </article>`).join("") : "No evidence matched this question.";
  } catch (error) {
    $("#results").textContent = error.message;
    setStatus(error.message);
  }
});

$("#documents").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-document");
  if (deleteButton) {
    const document = state.documents.find((item) => item.id === deleteButton.dataset.id);
    if (!document) return;
    const label = document.title || document.filename;
    const group = document.group_name || document.group_slug || "Unknown group";
    if (!window.confirm(`Delete “${label}” from ${group}? This permanently removes this document from the RAG library.`)) return;
    deleteButton.disabled = true;
    deleteButton.textContent = "Deletingâ€¦";
    $("#documents-result").textContent = `Deleting “${label}”…`;
    try {
      const result = await api(`/v1/documents/${document.id}`, { method: "DELETE" });
      await loadDocuments();
      if (result.storage_cleanup === "failed") {
        $("#documents-result").textContent = `Deleted “${label}” from the library, but private file cleanup needs operator attention.`;
        $("#documents-result").dataset.kind = "error";
        setStatus("Document deleted; file cleanup warning");
      } else {
        $("#documents-result").textContent = `Deleted “${label}”.`;
        $("#documents-result").dataset.kind = "success";
        setStatus("Document deleted", true);
      }
    } catch (error) {
      deleteButton.disabled = false;
      deleteButton.textContent = "Delete";
      $("#documents-result").textContent = `Could not delete “${label}”: ${error.message}`;
      $("#documents-result").dataset.kind = "error";
      setStatus(error.message);
    }
    return;
  }

  const downloadButton = event.target.closest(".download");
  if (!downloadButton) return;
  try {
    const result = await api(`/v1/documents/${downloadButton.dataset.id}/signed-link`, { method: "POST" });
    window.open(result.url, "_blank", "noopener,noreferrer");
  } catch (error) { setStatus(error.message); }
});

connectWithVoiceConnect();

