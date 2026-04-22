/**
 * ai-key-manager.js  (v2 — multi-provider with per-provider keys)
 *
 * Providers supported:
 *   Gemini · OpenAI · Claude · Mistral · DeepSeek · Local/Qwen · Custom
 *
 * Config is stored in localStorage with each key XOR-obfuscated.
 * Per-provider keys, endpoints, and models are all persisted.
 */

const STORAGE_KEY = "ai_cfg_v2";
const XOR_SEED    = 0x4b;

// ── Provider registry ─────────────────────────────────────────────────────────
export const PROVIDERS = [
  {
    id:        "gemini",
    name:      "Gemini",
    logo:      "✦",
    desc:      "Google Gemini 2.0 / 1.5",
    badge:     "Free tier",
    docsUrl:   "https://aistudio.google.com/app/apikey",
    placeholder: "AIza...",
    apiStyle:  "gemini",
    defaultEndpoint: "",
    defaultModel:    "gemini-2.0-flash",
    models:    ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
    requiresKey: true,
    configurable: false,
  },
  {
    id:        "openai",
    name:      "OpenAI",
    logo:      "⬡",
    desc:      "GPT-4o, GPT-4 Turbo",
    badge:     null,
    docsUrl:   "https://platform.openai.com/api-keys",
    placeholder: "sk-...",
    apiStyle:  "openai",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel:    "gpt-4o",
    models:    ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    requiresKey: true,
    configurable: false,
  },
  {
    id:        "claude",
    name:      "Claude",
    logo:      "◈",
    desc:      "Anthropic Claude 3.5",
    badge:     null,
    docsUrl:   "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-...",
    apiStyle:  "claude",
    defaultEndpoint: "https://api.anthropic.com/v1/messages",
    defaultModel:    "claude-3-5-sonnet-20241022",
    models:    ["claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"],
    requiresKey: true,
    configurable: false,
  },
  {
    id:        "mistral",
    name:      "Mistral",
    logo:      "M",
    desc:      "Mistral Large / Small",
    badge:     null,
    docsUrl:   "https://console.mistral.ai/api-keys",
    placeholder: "...",
    apiStyle:  "openai",
    defaultEndpoint: "https://api.mistral.ai/v1/chat/completions",
    defaultModel:    "mistral-large-latest",
    models:    ["mistral-large-latest", "mistral-small-latest", "open-mistral-nemo"],
    requiresKey: true,
    configurable: false,
  },
  {
    id:        "deepseek",
    name:      "DeepSeek",
    logo:      "D",
    desc:      "DeepSeek V3 / R1",
    badge:     null,
    docsUrl:   "https://platform.deepseek.com/api_keys",
    placeholder: "sk-...",
    apiStyle:  "openai",
    defaultEndpoint: "https://api.deepseek.com/v1/chat/completions",
    defaultModel:    "deepseek-chat",
    models:    ["deepseek-chat", "deepseek-reasoner"],
    requiresKey: true,
    configurable: false,
  },
  {
    id:        "local",
    name:      "Local / Qwen",
    logo:      "⌬",
    desc:      "Ollama · LM Studio · Qwen",
    badge:     "Local",
    docsUrl:   "https://ollama.ai",
    placeholder: "(leave empty for Ollama)",
    apiStyle:  "openai",
    defaultEndpoint: "http://localhost:11434/v1/chat/completions",
    defaultModel:    "qwen2.5:7b",
    models:    ["qwen2.5:7b", "qwen2.5:14b", "llama3.2", "phi4", "mistral"],
    requiresKey: false,
    configurable: true, // shows endpoint + model fields
  },
  {
    id:        "custom",
    name:      "Custom",
    logo:      "⚙",
    desc:      "Any OpenAI-compatible API",
    badge:     null,
    docsUrl:   "",
    placeholder: "your-api-key (or leave empty)",
    apiStyle:  "openai",
    defaultEndpoint: "",
    defaultModel:    "",
    models:    [],
    requiresKey: false,
    configurable: true, // shows endpoint + model fields
  },
];

// ── Obfuscation ───────────────────────────────────────────────────────────────
function xorEncode(str) {
  return Array.from(str)
    .map((ch) => (ch.charCodeAt(0) ^ XOR_SEED).toString(16).padStart(2, "0"))
    .join("");
}

function xorDecode(hex) {
  try {
    const chars = [];
    for (let i = 0; i < hex.length; i += 2) {
      chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ XOR_SEED));
    }
    return chars.join("");
  } catch {
    return "";
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────
function saveConfig(cfg) {
  const payload = JSON.parse(JSON.stringify(cfg));
  // Obfuscate all stored keys
  for (const id of Object.keys(payload.keys)) {
    if (payload.keys[id]) payload.keys[id] = xorEncode(payload.keys[id]);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    for (const id of Object.keys(payload.keys || {})) {
      if (payload.keys[id]) payload.keys[id] = xorDecode(payload.keys[id]);
    }
    return payload;
  } catch {
    return null;
  }
}

function defaultConfig() {
  const keys = {};
  const opts = {};
  for (const p of PROVIDERS) {
    keys[p.id] = "";
    opts[p.id] = { endpoint: p.defaultEndpoint, model: p.defaultModel };
  }
  return { providerId: "gemini", keys, options: opts };
}

// ── Singleton ─────────────────────────────────────────────────────────────────
class KeyManager {
  constructor() {
    const stored = loadConfig();
    this._cfg = stored ?? defaultConfig();
    // Migrate old v1 config if present
    if (!this._cfg.keys) this._cfg = defaultConfig();
    // Ensure all providers have entries (handles new providers added later)
    for (const p of PROVIDERS) {
      if (!this._cfg.keys[p.id])    this._cfg.keys[p.id] = "";
      if (!this._cfg.options[p.id]) this._cfg.options[p.id] = { endpoint: p.defaultEndpoint, model: p.defaultModel };
    }
    this._modal        = null;
    this._settingsBtn  = null;
    this._callbacks    = new Set();
  }

  getProvider()  { return PROVIDERS.find((p) => p.id === this._cfg.providerId) ?? PROVIDERS[0]; }
  getProviders() { return PROVIDERS; }
  getKey()       { return this._cfg.keys[this._cfg.providerId] || ""; }
  getEndpoint()  { return this._cfg.options[this._cfg.providerId]?.endpoint || this.getProvider().defaultEndpoint; }
  getModel()     { return this._cfg.options[this._cfg.providerId]?.model    || this.getProvider().defaultModel;    }

  isReady() {
    const provider = this.getProvider();
    if (!provider.requiresKey) return true; // local/custom don't need a key
    return Boolean(this.getKey().trim().length > 6);
  }

  onChange(fn)  { this._callbacks.add(fn); return () => this._callbacks.delete(fn); }
  _emit()       { this._updateSettingsBtn(); for (const fn of this._callbacks) fn(this._cfg); }

  // ── Topbar button ───────────────────────────────────────────────────────────
  injectSettingsButton() {
    const topbar = document.querySelector(".topbar");
    if (!topbar || document.getElementById("ai-settings-btn")) return;
    const btn = document.createElement("button");
    btn.id   = "ai-settings-btn";
    btn.type = "button";
    btn.innerHTML = `<span class="ai-btn-icon">✦</span><span>AI</span><span class="ai-provider-badge none">—</span>`;
    btn.addEventListener("click", () => this.openModal());
    topbar.appendChild(btn);
    this._settingsBtn = btn;
    this._updateSettingsBtn();
  }

  _updateSettingsBtn() {
    const btn = this._settingsBtn;
    if (!btn) return;
    const provider = this.getProvider();
    const badge = btn.querySelector(".ai-provider-badge");
    if (badge) {
      badge.textContent = this.isReady() ? provider.name : "—";
      badge.className   = `ai-provider-badge ${this.isReady() ? provider.id : "none"}`;
    }
  }

  // ── Modal ───────────────────────────────────────────────────────────────────
  openModal(onSaved) {
    if (!this._modal) this._buildModal();
    this._populateModal();
    this._modal.classList.remove("hidden");
    this._onSavedCallback = onSaved || null;
  }

  closeModal() { this._modal?.classList.add("hidden"); }

  _buildModal() {
    const el = document.createElement("div");
    el.id = "ai-settings-modal";
    el.className = "hidden";
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `
      <div class="ai-modal-card">
        <div class="ai-modal-header">
          <div>
            <h2>AI Settings</h2>
            <p>Choose your provider and configure access. Keys are stored obfuscated locally.</p>
          </div>
          <button id="ai-modal-close" class="icon-button" type="button" aria-label="Close">×</button>
        </div>

        <div class="ai-provider-grid" id="ai-provider-grid"></div>

        <div class="ai-key-section">
          <div class="ai-key-label">
            <span id="ai-key-label-text">API Key</span>
            <a id="ai-key-docs-link" href="#" target="_blank" rel="noopener">Get a key ↗</a>
          </div>
          <div class="ai-key-input-row">
            <input id="ai-key-input" class="ai-key-input" type="password" autocomplete="off" spellcheck="false" />
            <button id="ai-key-toggle" class="ai-key-toggle" type="button">Show</button>
          </div>
        </div>

        <div class="ai-endpoint-section hidden" id="ai-endpoint-section">
          <div class="ai-key-label"><span>API Endpoint URL</span></div>
          <input id="ai-endpoint-input" class="ai-key-input" type="text" autocomplete="off" placeholder="http://localhost:11434/v1/chat/completions" />
          <div class="ai-key-label" style="margin-top:10px"><span>Model Name</span></div>
          <input id="ai-model-input" class="ai-key-input" type="text" autocomplete="off" placeholder="qwen2.5:7b" />
        </div>

        <div id="ai-key-status" class="ai-key-status muted"></div>

        <div class="ai-modal-actions">
          <button id="ai-key-clear"   class="ghost-button"  type="button">Clear key</button>
          <button id="ai-modal-cancel" class="ghost-button" type="button">Cancel</button>
          <button id="ai-key-save"    class="solid-button"  type="button">Save & close</button>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._modal = el;

    el.addEventListener("click", (ev) => { if (ev.target === el) this.closeModal(); });
    el.querySelector("#ai-modal-close").addEventListener("click",  () => this.closeModal());
    el.querySelector("#ai-modal-cancel").addEventListener("click", () => this.closeModal());
    el.querySelector("#ai-key-save").addEventListener("click",     () => this._save());
    el.querySelector("#ai-key-clear").addEventListener("click",    () => this._clearKey());
    el.querySelector("#ai-key-toggle").addEventListener("click",   () => {
      const inp = el.querySelector("#ai-key-input");
      const btn = el.querySelector("#ai-key-toggle");
      const hidden = inp.type === "password";
      inp.type   = hidden ? "text" : "password";
      btn.textContent = hidden ? "Hide" : "Show";
    });
    el.querySelector("#ai-key-input").addEventListener("input", () =>
      this._setStatus("", "muted")
    );
  }

  _populateModal() {
    const modal = this._modal;
    const grid  = modal.querySelector("#ai-provider-grid");
    grid.innerHTML = "";

    for (const provider of PROVIDERS) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `ai-provider-card${provider.id === this._cfg.providerId ? " is-selected" : ""}`;
      card.dataset.providerId = provider.id;
      card.innerHTML = `
        <span class="ai-provider-logo">${provider.logo}</span>
        <span class="ai-provider-name">${provider.name}</span>
        <span class="ai-provider-desc">${provider.desc}</span>
        ${provider.badge ? `<span class="ai-provider-free-badge">${provider.badge}</span>` : ""}
      `;
      card.addEventListener("click", () => {
        modal.querySelectorAll(".ai-provider-card").forEach((c) => c.classList.remove("is-selected"));
        card.classList.add("is-selected");
        this._cfg.providerId = provider.id;
        this._refreshModalForProvider();
      });
      grid.appendChild(card);
    }

    this._refreshModalForProvider();

    // Restore key for selected provider
    const keyInput = modal.querySelector("#ai-key-input");
    keyInput.value  = this._cfg.keys[this._cfg.providerId] || "";
    keyInput.type   = "password";
    modal.querySelector("#ai-key-toggle").textContent = "Show";

    const ready = this.isReady();
    this._setStatus(ready ? "✓ Key saved." : "", ready ? "is-ok" : "muted");
  }

  _refreshModalForProvider() {
    const modal    = this._modal;
    const provider = PROVIDERS.find((p) => p.id === this._cfg.providerId) ?? PROVIDERS[0];
    const opts     = this._cfg.options[provider.id] || {};

    // Update key label & docs link
    const label    = modal.querySelector("#ai-key-label-text");
    const docsLink = modal.querySelector("#ai-key-docs-link");
    const keyInput = modal.querySelector("#ai-key-input");
    if (label)    label.textContent    = provider.requiresKey ? `${provider.name} API Key` : "API Key (optional)";
    if (docsLink) {
      docsLink.href        = provider.docsUrl || "#";
      docsLink.style.display = provider.docsUrl ? "" : "none";
    }
    if (keyInput) {
      keyInput.placeholder = provider.placeholder;
      keyInput.value       = this._cfg.keys[provider.id] || "";
    }

    // Show/hide endpoint section
    const endpointSection = modal.querySelector("#ai-endpoint-section");
    const endpointInput   = modal.querySelector("#ai-endpoint-input");
    const modelInput      = modal.querySelector("#ai-model-input");

    if (provider.configurable) {
      endpointSection.classList.remove("hidden");
      if (endpointInput) endpointInput.value = opts.endpoint || provider.defaultEndpoint;
      if (modelInput)    modelInput.value    = opts.model    || provider.defaultModel;
    } else {
      endpointSection.classList.add("hidden");
    }

    this._setStatus("", "muted");
  }

  _save() {
    const modal   = this._modal;
    const provider = PROVIDERS.find((p) => p.id === this._cfg.providerId) ?? PROVIDERS[0];
    const key     = modal.querySelector("#ai-key-input").value.trim();

    if (provider.requiresKey && !key) {
      this._setStatus("Please enter an API key.", "is-error"); return;
    }
    if (provider.requiresKey && key.length < 8) {
      this._setStatus("Key looks too short — double-check it.", "is-error"); return;
    }

    // Save key
    this._cfg.keys[provider.id] = key;

    // Save endpoint/model if configurable
    if (provider.configurable) {
      const endpoint = modal.querySelector("#ai-endpoint-input")?.value.trim() || provider.defaultEndpoint;
      const model    = modal.querySelector("#ai-model-input")?.value.trim()    || provider.defaultModel;
      this._cfg.options[provider.id] = { endpoint, model };
    }

    saveConfig(this._cfg);
    this._setStatus("✓ Saved!", "is-ok");
    this._emit();

    setTimeout(() => {
      this.closeModal();
      if (this._onSavedCallback) { this._onSavedCallback(); this._onSavedCallback = null; }
    }, 600);
  }

  _clearKey() {
    this._cfg.keys[this._cfg.providerId] = "";
    saveConfig(this._cfg);
    if (this._modal) {
      const inp = this._modal.querySelector("#ai-key-input");
      if (inp) inp.value = "";
    }
    this._setStatus("Key cleared.", "muted");
    this._emit();
  }

  _setStatus(msg, cls) {
    const el = this._modal?.querySelector("#ai-key-status");
    if (!el) return;
    el.textContent = msg;
    el.className   = `ai-key-status ${cls}`;
  }
}

export const keyManager = new KeyManager();
