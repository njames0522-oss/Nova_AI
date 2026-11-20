
/* Nova AI frontend. All privileged provider calls go through the authenticated Edge Function. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const MODELS = {
    groq: [
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-20b",
      "qwen/qwen3-32b"
    ],
    openrouter: [
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.5-flash"
    ]
  };

  const PROVIDER_LABELS = {
    groq: "Groq",
    openrouter: "OpenRouter"
  };

  let db, user, conversations = [], currentId = null;
  let messages = [], prompts = [], settings = {};
  let busy = false, aborter = null, authMode = "login", attachments = [];

  const toast = (msg) => {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  }[c]));

  const validConfig = () =>
    window.NOVA_CONFIG &&
    !window.NOVA_CONFIG.SUPABASE_URL.includes("YOUR_") &&
    !window.NOVA_CONFIG.SUPABASE_ANON_KEY.includes("YOUR_");

  async function init() {
    if (!validConfig() || !window.supabase) {
      $("#authNotice").textContent =
        "First configure config.js with your Supabase project URL and publishable key.";
      return;
    }

    db = window.supabase.createClient(
      NOVA_CONFIG.SUPABASE_URL,
      NOVA_CONFIG.SUPABASE_ANON_KEY
    );

    const { data: { session } } = await db.auth.getSession();
    if (session) await enterApp(session.user);

    db.auth.onAuthStateChange(async (event, session) => {
      if (session && !user) await enterApp(session.user);
      if (event === "SIGNED_OUT") {
        user = null;
        $("#app").classList.add("hidden");
        $("#authScreen").classList.remove("hidden");
      }
    });
  }

  async function enterApp(u) {
    user = u;
    $("#authScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");

    $("#profileEmail").textContent = u.email || "";
    $("#profileName").textContent = (u.email || "Account").split("@")[0];
    $("#avatar").textContent = (u.email || "N").slice(0, 1).toUpperCase();
    $("#accountEmail").textContent = u.email || "";

    await Promise.all([
      loadSettings(),
      loadPrompts(),
      loadConversations()
    ]);

    renderPromptSelectors();
    applyTheme();
    startNewChat();
  }

  async function authSubmit(e) {
    e.preventDefault();

    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    const btn = $("#authSubmit");
    btn.disabled = true;

    try {
      const result = authMode === "signup"
        ? await db.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: location.href.split("#")[0] }
          })
        : await db.auth.signInWithPassword({ email, password });

      if (result.error) throw result.error;

      if (authMode === "signup" && !result.data.session) {
        toast("Check your email to confirm your account.");
      } else if (result.data.user) {
        await enterApp(result.data.user);
      }
    } catch (e) {
      toast(e.message || "Authentication failed.");
    } finally {
      btn.disabled = false;
    }
  }

  async function googleLogin() {
    const { error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.href.split("#")[0] }
    });
    if (error) toast(error.message);
  }

  async function forgot() {
    const email = $("#authEmail").value.trim();
    if (!email) return toast("Enter your email first.");

    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: location.href.split("#")[0]
    });

    toast(error ? error.message : "Password recovery email sent.");
  }

  async function loadSettings() {
    const { data, error } = await db
      .from("user_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) console.warn(error);

    settings = data || {
      theme: "dark",
      provider: "groq",
      model: MODELS.groq[0],
      temperature: 0.7,
      response_length: "balanced",
      custom_instructions: "",
      instructions_enabled: true
    };

    // Migrate older saved settings to the supported providers.
    if (!MODELS[settings.provider]) settings.provider = "groq";
    if (!MODELS[settings.provider].includes(settings.model)) {
      settings.model = MODELS[settings.provider][0];
    }

    $("#themeSetting").value = settings.theme || "dark";

    populateProviderSelect($("#defaultProvider"), settings.provider);
    populateModelSelect($("#defaultModel"), settings.provider, settings.model);

    $("#lengthSetting").value = settings.response_length || "balanced";
    $("#temperatureSetting").value = settings.temperature ?? 0.7;
    $("#temperatureValue").textContent = String(settings.temperature ?? 0.7);
    $("#customInstructions").value = settings.custom_instructions || "";
    $("#instructionsEnabled").checked = settings.instructions_enabled !== false;

    populateProviderSelect($("#providerSelect"), settings.provider);
    populateModelSelect($("#modelSelect"), settings.provider, settings.model);
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };

    const { error } = await db.from("user_settings").upsert({
      user_id: user.id,
      ...settings,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    if (error) throw error;
  }

  async function loadPrompts() {
    const { data, error } = await db
      .from("custom_prompts")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    prompts = data || [];
    renderPrompts();
  }

  async function loadConversations() {
    const { data, error } = await db
      .from("conversations")
      .select("id,title,is_pinned,is_favorite,updated_at")
      .order("updated_at", { ascending: false });

    if (error) throw error;
    conversations = data || [];
    renderConversationList();
  }

  async function loadMessages(id) {
    const { data, error } = await db
      .from("messages")
      .select("*")
      .eq("conversation_id", id)
      .order("created_at");

    if (error) throw error;
    messages = data || [];
    renderMessages();
  }

  function populateProviderSelect(el, selected) {
    el.innerHTML = Object.entries(PROVIDER_LABELS)
      .map(([value, label]) =>
        `<option value="${value}">${label}</option>`
      ).join("");

    el.value = MODELS[selected] ? selected : "groq";
  }

  function populateModelSelect(el, provider, selected) {
    const models = MODELS[provider] || MODELS.groq;

    el.innerHTML = models
      .map(m => `<option value="${esc(m)}">${esc(m)}</option>`)
      .join("");

    el.value = selected && models.includes(selected)
      ? selected
      : models[0];
  }

  function activePrompt() {
    const id = $("#promptSelect").value;
    return prompts.find(p => p.id === id) || null;
  }

  function renderPromptSelectors() {
    const opts = prompts.map(p =>
      `<option value="${p.id}">${esc(p.name)}${p.is_default ? " · default" : ""}</option>`
    ).join("");

    $("#promptSelect").innerHTML =
      '<option value="">Default instructions</option>' + opts;

    const def = prompts.find(p => p.is_default);
    if (def) $("#promptSelect").value = def.id;

    updatePromptLabel();
  }

  function updatePromptLabel() {
    const p = activePrompt();
    $("#activePromptLabel").textContent = p ? p.name : "Default prompt";
  }

  function renderPrompts() {
    $("#savedPrompts").innerHTML = prompts.map(p =>
      `<div class="saved-prompt">
        <span><b>${esc(p.name)}</b>${p.is_default ? ' <small class="muted">Default</small>' : ""}</span>
        <button data-use-prompt="${p.id}">Use</button>
        <button data-edit-prompt="${p.id}">Edit</button>
        <button data-delete-prompt="${p.id}">Delete</button>
      </div>`
    ).join("") || '<p class="muted">No saved presets yet.</p>';

    renderPromptSelectors();
  }

  async function savePrompt() {
    const name = $("#promptName").value.trim();
    const content = $("#promptContent").value.trim();

    if (!name || !content) return toast("Enter a name and prompt.");

    const makeDefault = $("#promptDefault").checked;

    try {
      if (makeDefault) {
        await db.from("custom_prompts")
          .update({ is_default: false })
          .eq("user_id", user.id);
      }

      const { error } = await db.from("custom_prompts").insert({
        user_id: user.id,
        name,
        prompt_content: content,
        is_default: makeDefault
      });

      if (error) throw error;

      $("#promptName").value = "";
      $("#promptContent").value = "";
      $("#promptDefault").checked = false;

      await loadPrompts();
      toast("Prompt preset saved.");
    } catch (e) {
      toast(e.message);
    }
  }

  async function saveInstructions() {
    try {
      await saveSettings({
        custom_instructions: $("#customInstructions").value,
        instructions_enabled: $("#instructionsEnabled").checked
      });
      toast("Instructions saved.");
    } catch (e) {
      toast(e.message);
    }
  }

  async function renderConversationList() {
    const q = $("#chatSearch").value.toLowerCase();
    const filtered = conversations.filter(c =>
      c.title.toLowerCase().includes(q)
    );

    $("#conversationList").innerHTML = filtered.map(c =>
      `<div class="conversation-item ${c.id === currentId ? "active" : ""}">
        <button data-open-chat="${c.id}">${c.is_pinned ? "📌 " : ""}${c.is_favorite ? "★ " : ""}${esc(c.title)}</button>
        <button class="more" data-chat-menu="${c.id}" title="Conversation actions">···</button>
      </div>`
    ).join("") || '<p class="muted tiny" style="padding:8px">No conversations yet.</p>';
  }

  async function createConversation() {
    const p = activePrompt();

    const { data, error } = await db.from("conversations").insert({
      user_id: user.id,
      title: "New chat",
      prompt_id: p?.id || null,
      system_prompt: p?.prompt_content || null
    }).select().single();

    if (error) throw error;

    currentId = data.id;
    messages = [];
    $("#currentTitle").textContent = data.title;
    renderMessages();
    await loadConversations();

    return data;
  }

  function startNewChat() {
    currentId = null;
    messages = [];
    $("#currentTitle").textContent = "New chat";
    $("#messages").innerHTML = "";
    $("#welcome").classList.remove("hidden");
    renderConversationList();
    $("#messageInput").focus();
  }

  async function openConversation(id) {
    currentId = id;
    const c = conversations.find(x => x.id === id);
    $("#currentTitle").textContent = c?.title || "Chat";

    await loadMessages(id);
    $("#welcome").classList.toggle("hidden", messages.length > 0);
    renderConversationList();
    $("#sidebar").classList.remove("mobile-open");
  }

  function renderMessages() {
    $("#welcome").classList.toggle("hidden", messages.length > 0);
    $("#messages").innerHTML = messages.map((m, i) => messageHTML(m, i)).join("");
    $("#messages").querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
    $("#chatView").scrollTop = $("#chatView").scrollHeight;
  }

  function markdown(s) {
    return DOMPurify.sanitize(marked.parse(s || "", { breaks: true, gfm: true }));
  }

  function messageHTML(m, i) {
    const assistant = m.role === "assistant";

    return `<article class="message ${assistant ? "assistant" : "user"}" data-message-id="${m.id || ""}">
      ${assistant ? '<div class="role-icon">✳</div>' : ""}
      <div class="bubble">
        ${assistant ? markdown(m.content) : `<p>${esc(m.content).replace(/\n/g, "<br>")}</p>`}
        ${assistant
          ? `<div class="message-actions"><button data-copy-message="${i}">Copy</button><button data-regenerate="${i}">Regenerate</button></div>`
          : `<div class="message-actions"><button data-edit-message="${i}">Edit</button></div>`}
      </div>
      ${assistant ? "" : '<div class="role-icon">◉</div>'}
    </article>`;
  }

  async function saveMessage(role, content, extra = {}) {
    const { data, error } = await db.from("messages").insert({
      user_id: user.id,
      conversation_id: currentId,
      role,
      content,
      ...extra
    }).select().single();

    if (error) throw error;
    messages.push(data);
    return data;
  }

  async function sendMessage(textOverride = null) {
    if (busy) return;

    const input = $("#messageInput");
    const content = (textOverride ?? input.value).trim();

    if (!content && !attachments.length) return;
    if (!currentId) await createConversation();

    input.value = "";
    input.style.height = "auto";
    $("#welcome").classList.add("hidden");

    const userText = content + (attachments.length
      ? `\n\nAttachments: ${attachments.map(a => a.name).join(", ")}`
      : "");

    await saveMessage("user", userText);
    renderMessages();

    busy = true;
    aborter = new AbortController();
    $("#sendButton").textContent = "■";
    $("#sendButton").title = "Stop generating";

    const placeholder = { role: "assistant", content: "", id: "streaming" };
    messages.push(placeholder);
    renderMessages();

    try {
      const p = activePrompt();
      const provider = $("#providerSelect").value;
      const model = $("#modelSelect").value;

      const payload = {
        provider,
        model,
        temperature: Number($("#temperatureSetting").value || settings.temperature || 0.7),
        response_length: $("#lengthSetting").value || settings.response_length || "balanced",
        custom_instructions: settings.instructions_enabled === false
          ? ""
          : (settings.custom_instructions || ""),
        prompt_content: p?.prompt_content || null,
        prompt_name: p?.name || null,
        conversation_instructions: null,
        messages: messages
          .filter(m => m.id !== "streaming")
          .map(m => ({ role: m.role, content: m.content })),
        attachments: attachments.map(a => ({
          name: a.name,
          type: a.type,
          data: a.data
        }))
      };

      const { data: { session } } = await db.auth.getSession();

      const res = await fetch(`${NOVA_CONFIG.FUNCTIONS_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": NOVA_CONFIG.SUPABASE_ANON_KEY
        },
        body: JSON.stringify(payload),
        signal: aborter.signal
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error || `AI request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;

          try {
            const packet = JSON.parse(raw);
            if (packet.error) throw new Error(packet.error);

            const delta = packet.delta || "";
            answer += delta;
            messages[messages.length - 1].content = answer;
            renderMessages();
          } catch (e) {
            if (e.message !== "Unexpected end of JSON input") throw e;
          }
        }
      }

      messages.pop();
      await saveMessage("assistant", answer || "No response was returned.");

      await db.from("usage_statistics").insert({
        user_id: user.id,
        provider,
        model,
        input_messages: payload.messages.length,
        output_characters: answer.length
      });

      if (messages.filter(m => m.role === "user").length === 1) {
        const title = content.slice(0, 52) + (content.length > 52 ? "…" : "");
        await db.from("conversations")
          .update({ title, updated_at: new Date().toISOString() })
          .eq("id", currentId);

        $("#currentTitle").textContent = title;
      }

      await loadConversations();
      renderMessages();
    } catch (e) {
      messages.pop();
      renderMessages();
      if (e.name !== "AbortError") toast(e.message || "Something went wrong.");
    } finally {
      busy = false;
      aborter = null;
      $("#sendButton").textContent = "↑";
      $("#sendButton").title = "Send";
      attachments = [];
      $("#fileInput").value = "";
    }
  }

  async function regenerate(index) {
    const userIndex = [...messages.slice(0, index)]
      .map(m => m.role)
      .lastIndexOf("user");

    if (userIndex < 0) return;

    const lastUser = messages[userIndex];
    const toRemove = messages.slice(userIndex).filter(m => m.id);

    if (toRemove.length) {
      await db.from("messages").delete().in("id", toRemove.map(m => m.id));
    }

    messages = messages.slice(0, userIndex);
    renderMessages();
    await sendMessage(lastUser.content);
  }

  async function editMessage(index) {
    const m = messages[index];
    const next = prompt("Edit your message:", m.content);

    if (next === null || !next.trim()) return;

    await db.from("messages")
      .delete()
      .eq("conversation_id", currentId)
      .gte("created_at", m.created_at);

    messages = messages.slice(0, index);
    await sendMessage(next.trim());
  }

  async function handleFileChange(e) {
    for (const f of e.target.files) {
      if (f.size > 8 * 1024 * 1024) {
        toast(`${f.name} is larger than 8 MB.`);
        continue;
      }

      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(f);
      });

      attachments.push({
        name: f.name,
        type: f.type || "text/plain",
        data
      });
    }

    if (attachments.length) toast(`${attachments.length} attachment(s) ready.`);
  }

  async function renameConversation(id) {
    const c = conversations.find(x => x.id === id);
    const title = prompt("Conversation title:", c?.title || "");

    if (!title?.trim()) return;

    await db.from("conversations").update({ title: title.trim() }).eq("id", id);
    await loadConversations();

    if (id === currentId) $("#currentTitle").textContent = title.trim();
  }

  async function chatMenu(id) {
    const action = prompt("Type: rename, pin, favorite, delete");
    if (!action) return;

    const c = conversations.find(x => x.id === id);

    if (action === "rename") return renameConversation(id);

    if (action === "pin" || action === "favorite") {
      const field = action === "pin" ? "is_pinned" : "is_favorite";
      await db.from("conversations").update({ [field]: !c[field] }).eq("id", id);
    }

    if (action === "delete") {
      if (!confirm("Delete this conversation and its messages?")) return;
      await db.from("conversations").delete().eq("id", id);
      if (currentId === id) startNewChat();
    }

    await loadConversations();
  }

  async function exportChats() {
    const { data, error } = await db.from("conversations")
      .select("*,messages(*)")
      .order("created_at");

    if (error) return toast(error.message);

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json"
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nova-conversations.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function deleteAll() {
    if (!confirm("Permanently delete all your conversations?")) return;

    const { error } = await db.from("conversations")
      .delete()
      .eq("user_id", user.id);

    if (error) return toast(error.message);

    startNewChat();
    await loadConversations();
    toast("All conversations deleted.");
  }

  function applyTheme() {
    const t = $("#themeSetting").value || settings.theme || "dark";

    document.body.classList.toggle(
      "light",
      t === "light" ||
      (t === "system" && matchMedia("(prefers-color-scheme: light)").matches)
    );
  }

  function openSettings() {
    $("#settingsModal").classList.remove("hidden");
  }

  function closeModal(id) {
    $("#" + id).classList.add("hidden");
  }

  function bind() {
    $("#authForm").addEventListener("submit", authSubmit);
    $("#googleLogin").onclick = googleLogin;
    $("#forgotPassword").onclick = forgot;

    $$("[data-auth-tab]").forEach(b => b.onclick = () => {
      authMode = b.dataset.authTab;
      $$("[data-auth-tab]").forEach(x => x.classList.toggle("active", x === b));
      $("#authSubmit").textContent = authMode === "login" ? "Sign in" : "Create account";
    });

    $("#newChat").onclick = startNewChat;
    $("#brandHome").onclick = startNewChat;
    $("#sendButton").onclick = () => busy ? aborter?.abort() : sendMessage();

    $("#messageInput").addEventListener("input", e => {
      e.target.style.height = "auto";
      e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
    });

    $("#messageInput").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    $("#fileInput").onchange = handleFileChange;
    $("#chatSearch").oninput = renderConversationList;
    $("#settingsButton").onclick = openSettings;

    $("#collapseSidebar").onclick = () => $("#sidebar").classList.toggle("collapsed");
    $("#mobileMenu").onclick = () => $("#sidebar").classList.toggle("mobile-open");

    $$("[data-close]").forEach(b => b.onclick = () => closeModal(b.dataset.close));

    $$("[data-settings-tab]").forEach(b => b.onclick = () => {
      $$("[data-settings-tab]").forEach(x => x.classList.toggle("active", x === b));
      $$("[data-pane]").forEach(x =>
        x.classList.toggle("active", x.dataset.pane === b.dataset.settingsTab)
      );
    });

    $("#savePrompt").onclick = savePrompt;
    $("#saveInstructions").onclick = saveInstructions;

    $("#themeSetting").onchange = () => {
      applyTheme();
      saveSettings({ theme: $("#themeSetting").value }).catch(e => toast(e.message));
    };

    $("#temperatureSetting").oninput = () => {
      $("#temperatureValue").textContent = $("#temperatureSetting").value;
    };

    $("#temperatureSetting").onchange = () => {
      saveSettings({ temperature: Number($("#temperatureSetting").value) })
        .catch(e => toast(e.message));
    };

    $("#lengthSetting").onchange = () => {
      saveSettings({ response_length: $("#lengthSetting").value })
        .catch(e => toast(e.message));
    };

    $("#defaultProvider").onchange = () => {
      const provider = $("#defaultProvider").value;
      populateModelSelect($("#defaultModel"), provider);
      populateProviderSelect($("#providerSelect"), provider);
      populateModelSelect($("#modelSelect"), provider, $("#defaultModel").value);

      saveSettings({ provider, model: $("#defaultModel").value })
        .catch(e => toast(e.message));
    };

    $("#defaultModel").onchange = () => {
      saveSettings({
        provider: $("#defaultProvider").value,
        model: $("#defaultModel").value
      }).then(() => {
        $("#providerSelect").value = settings.provider;
        populateModelSelect($("#modelSelect"), settings.provider, settings.model);
      }).catch(e => toast(e.message));
    };

    $("#providerSelect").onchange = () => {
      populateModelSelect($("#modelSelect"), $("#providerSelect").value);

      saveSettings({
        provider: $("#providerSelect").value,
        model: $("#modelSelect").value
      }).catch(e => toast(e.message));
    };

    $("#modelSelect").onchange = () => {
      saveSettings({
        provider: $("#providerSelect").value,
        model: $("#modelSelect").value
      }).catch(e => toast(e.message));
    };

    $("#promptSelect").onchange = updatePromptLabel;
    $("#exportChats").onclick = exportChats;
    $("#deleteAllChats").onclick = deleteAll;
    $("#logoutButton").onclick = () => db.auth.signOut();

    $("#conversationList").onclick = e => {
      const open = e.target.closest("[data-open-chat]");
      const menu = e.target.closest("[data-chat-menu]");

      if (open) openConversation(open.dataset.openChat);
      if (menu) chatMenu(menu.dataset.chatMenu);
    };

    $("#savedPrompts").onclick = async e => {
      const use = e.target.closest("[data-use-prompt]");
      const edit = e.target.closest("[data-edit-prompt]");
      const del = e.target.closest("[data-delete-prompt]");

      if (use) {
        $("#promptSelect").value = use.dataset.usePrompt;
        updatePromptLabel();
        closeModal("settingsModal");
      }

      if (edit) {
        const p = prompts.find(x => x.id === edit.dataset.editPrompt);
        $("#promptName").value = p.name;
        $("#promptContent").value = p.prompt_content;
        $("#promptDefault").checked = p.is_default;
      }

      if (del && confirm("Delete this prompt preset?")) {
        await db.from("custom_prompts").delete().eq("id", del.dataset.deletePrompt);
        await loadPrompts();
      }
    };

    $("#messages").onclick = e => {
      const c = e.target.closest("[data-copy-message]");
      const r = e.target.closest("[data-regenerate]");
      const ed = e.target.closest("[data-edit-message]");

      if (c) {
        navigator.clipboard.writeText(messages[+c.dataset.copyMessage].content);
        toast("Copied.");
      }

      if (r) regenerate(+r.dataset.regenerate);
      if (ed) editMessage(+ed.dataset.editMessage);
    };

    $("#messages").addEventListener("click", e => {
      const b = e.target.closest("pre button");

      if (b) {
        const code = b.parentElement.querySelector("code");
        navigator.clipboard.writeText(code.innerText);
        toast("Code copied.");
      }
    });

    $("#messages").addEventListener("mouseover", e => {
      const pre = e.target.closest("pre");

      if (pre && !pre.querySelector("button")) {
        const b = document.createElement("button");
        b.textContent = "Copy code";
        pre.appendChild(b);
      }
    });

    $$(".suggestions button").forEach(b => b.onclick = () => {
      $("#messageInput").value = b.dataset.suggestion;
      sendMessage();
    });

    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        startNewChat();
      }

      if (e.key === "Escape") closeModal("settingsModal");
    });
  }

  bind();
  init().catch(e => {
    console.error(e);
    toast(e.message);
  });
})();
