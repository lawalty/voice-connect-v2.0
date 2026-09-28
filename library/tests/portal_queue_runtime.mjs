import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/static/ingestion-queue.js", import.meta.url), "utf8");
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "ingestion-queue.js" });
const { runSequentialQueue } = sandbox.RagIngestionQueue;

class FakeClassList {
  toggle() {}
  add() {}
  remove() {}
}

class FakeElement {
  constructor(selector) {
    this.selector = selector;
    this.value = "";
    this.files = [];
    this.elements = [];
    this.listeners = {};
    this.classList = new FakeClassList();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  scrollIntoView() {}
  focus() {}

  reset() {
    this.files = [];
  }
}

test("twenty files run sequentially and one failure does not stop later files", async () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ name: `document-${index + 1}.pdf` }));
  const started = [];
  let active = 0;
  let maximumActive = 0;

  const outcomes = await runSequentialQueue(files, async (file, index) => {
    started.push(file.name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (index === 7) throw new Error("Unreadable PDF");
    return file.name;
  });

  assert.deepEqual(started, files.map((file) => file.name));
  assert.equal(maximumActive, 1);
  assert.equal(outcomes.length, 20);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 19);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(outcomes[7].reason.message, "Unreadable PDF");
  assert.equal(outcomes[8].value, "document-9.pdf");
  assert.equal(outcomes[19].value, "document-20.pdf");
});

test("the portal submit handler attempts all twenty selected files and reports one skipped file", async () => {
  const appSource = readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement(selector));
    return elements.get(selector);
  };

  const uploadForm = element("#upload-form");
  const uploadFile = element("#upload-file");
  const uploadUrl = element("#upload-url");
  const uploadGroup = element("#upload-group");
  const processingMode = element("#processing-mode");
  const ingestButton = element("#ingest-source");
  uploadForm.elements = [uploadGroup, uploadFile, uploadUrl, processingMode, ingestButton];
  uploadForm.reset = () => {
    uploadFile.files = [];
    uploadUrl.value = "";
  };

  class FakeFormData {
    constructor(form) {
      this.values = new Map();
      if (form === uploadForm) {
        this.set("group", uploadGroup.value);
        this.set("processing_mode", processingMode.value);
      }
    }

    set(name, value, filename) {
      this.values.set(name, filename ? { ...value, name: filename } : value);
    }

    get(name) {
      return this.values.get(name) ?? null;
    }
  }

  const uploadedNames = [];
  const response = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  });
  const fetch = async (path, options = {}) => {
    if (path === "/api/status") return response(200, {authenticated: true, csrfToken: "test-csrf"});
    if (path === "/v1/groups") return response(200, []);
    if (path === "/v1/documents?limit=100") return response(200, []);
    if (path.startsWith("/v1/ingest/raw?")) {
      const params = new URL(path, "https://rag.example").searchParams;
      const name = params.get("filename");
      uploadedNames.push(name);
      if (name === "document-8.pdf") return response(422, { detail: "Unreadable PDF" });
      return response(202, { job_id: `job-${name}`, duplicate: false, retried: false });
    }
    if (path.startsWith("/v1/jobs/")) return response(200, { status: "completed" });
    throw new Error(`Unexpected request: ${path}`);
  };

  const storage = new Map([["rag-token", "test-operator-token"]]);
  const page = {
    globalThis: null,
    window: null,
    document: {
      querySelector: element,
      createElement: () => new FakeElement("created"),
    },
    sessionStorage: {
      getItem: (name) => storage.get(name) || null,
      setItem: (name, value) => storage.set(name, value),
    },
    Headers,
    URL,
    URLSearchParams,
    FormData: FakeFormData,
    fetch,
    setTimeout,
    clearTimeout,
    console,
  };
  page.globalThis = page;
  page.window = page;
  vm.runInNewContext(source, page, { filename: "ingestion-queue.js" });
  vm.runInNewContext(appSource, page, { filename: "app.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  uploadGroup.value = "work";
  processingMode.value = "gemini-3.7-flash";
  const expectedNames = Array.from({ length: 20 }, (_, index) => `document-${index + 1}.pdf`);
  uploadFile.files = expectedNames.map((name) => ({ name, type: "application/pdf" }));
  await uploadForm.listeners.submit({ preventDefault() {}, currentTarget: uploadForm });

  assert.deepEqual(uploadedNames, expectedNames);
  assert.equal(uploadFile.files.length, 0);
  assert.match(element("#upload-result").textContent, /20 attempted · 19 completed · 1 skipped/);
  assert.match(element("#upload-result").textContent, /document-8\.pdf: Unreadable PDF/);
  assert.equal(ingestButton.textContent, "Ingest selected sources");
  assert.equal(element("#status").textContent, "Ingestion queue needs attention");
});
