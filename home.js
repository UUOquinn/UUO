/**
 * 测试环境首页 — GitHub 风格统一聊天入口
 * 根据用户选择的功能或输入内容路由到对应能力模块
 */

const HOME_FEATURE_PLACEHOLDERS = {
  auto: "问我任何问题… 例如：今天某广告位有效请求率下降",
  diagnosis: "例如：今天某广告位有效请求率下降",
  "strategy-query": "例如：广告位ID 5118002323，或 开发者ID 12345",
  "strategy-audit": "例如：审核 13938，或直接输入策略 ID",
  "strategy-renewal": "例如：延期 13938 14619",
};

function getSelectedFeature() {
  const el = document.getElementById("homeFeatureSelect");
  const feature = el?.dataset.feature || "auto";
  return feature === "auto" ? null : feature;
}

function detectHomeIntent(text) {
  const t = (text || "").trim();
  if (!t) return null;

  if (/延期|到期|顺延|mergeEdit/i.test(t)) {
    return "strategy-renewal";
  }

  if (/审核|通过|驳回|发布|撤回/.test(t) && /\d{3,}/.test(t)) {
    return "strategy-audit";
  }

  if (/开发者\s*ID|广告位\s*ID|应用\s*ID|pos[_\s-]*id[：:\s]*\d|app[_\s-]*id[：:\s]*\d|\buid[：:\s]*\d/i.test(t)) {
    return "strategy-query";
  }

  if (/CPM|填充|曝光|请求|消耗|CTR|CVR|漏斗|诊断|下降|上升|跑量|有效请求率/.test(t)) {
    return "diagnosis";
  }

  if (/^\d{4,}(\s+\d{4,})*$/.test(t)) {
    return "strategy-query";
  }

  if (/^\d{3,}$/.test(t)) {
    return "strategy-audit";
  }

  return "diagnosis";
}

function routeFromHome(message) {
  const text = (message || "").trim();
  if (!text) return;

  const target = getSelectedFeature() || detectHomeIntent(text);
  if (!target || typeof window.switchView !== "function") return;

  window.switchView(target);

  window.setTimeout(() => {
    if (target === "diagnosis") {
      const question = document.getElementById("question");
      if (question) {
        question.value = text;
        if (typeof generateDiagnosis === "function") {
          generateDiagnosis();
        }
      }
      return;
    }

    const inputMap = {
      "strategy-query": "strategyChatInput",
      "strategy-audit": "auditChatInput",
      "strategy-renewal": "renewalChatInput",
    };
    const sendMap = {
      "strategy-query": "strategyChatSend",
      "strategy-audit": "auditChatSend",
      "strategy-renewal": "renewalChatSend",
    };

    const input = document.getElementById(inputMap[target]);
    const sendBtn = document.getElementById(sendMap[target]);
    if (!input) return;

    input.value = text;
    if (target === "strategy-query" && typeof window.sendStrategyQuery === "function") {
      window.sendStrategyQuery(text);
      return;
    }
    sendBtn?.click();
  }, 60);
}

function setHomeFeature(feature, label) {
  const select = document.getElementById("homeFeatureSelect");
  const labelEl = document.getElementById("homeFeatureLabel");
  const input = document.getElementById("homeChatInput");
  if (!select || !labelEl) return;

  select.dataset.feature = feature;
  labelEl.textContent = label;

  document.querySelectorAll(".gh-home-feature-option").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.feature === feature);
  });

  if (input && HOME_FEATURE_PLACEHOLDERS[feature]) {
    input.placeholder = HOME_FEATURE_PLACEHOLDERS[feature];
  }
}

function closeFeatureMenu() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;
  menu.hidden = true;
  select.setAttribute("aria-expanded", "false");
}

function toggleFeatureMenu() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  select.setAttribute("aria-expanded", open ? "true" : "false");
}

function initHomeFeatureSelect() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;

  select.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFeatureMenu();
  });

  select.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleFeatureMenu();
    } else if (e.key === "Escape") {
      closeFeatureMenu();
    }
  });

  menu.querySelectorAll(".gh-home-feature-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setHomeFeature(btn.dataset.feature, btn.dataset.label);
      closeFeatureMenu();
      document.getElementById("homeChatInput")?.focus();
    });
  });

  document.addEventListener("click", (e) => {
    if (!select.contains(e.target) && !menu.contains(e.target)) {
      closeFeatureMenu();
    }
  });
}

function initHomePage() {
  if (!document.documentElement.classList.contains("github-ui")) return;

  const input = document.getElementById("homeChatInput");
  const sendBtn = document.getElementById("homeChatSend");
  const composer = document.getElementById("homeComposer");
  if (!input || !sendBtn) return;

  initHomeFeatureSelect();

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    composer?.classList.remove("gh-home-composer-expanded");
    routeFromHome(text);
  }

  sendBtn.addEventListener("click", send);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  input.addEventListener("input", () => {
    composer?.classList.toggle("gh-home-composer-expanded", input.value.trim().length > 0);
  });
}

window.onHomeViewEnter = function onHomeViewEnter() {
  document.getElementById("homeChatInput")?.focus();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHomePage);
} else {
  initHomePage();
}
