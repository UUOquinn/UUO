/**
 * 非首页能力模块 · 框外输入提示块（生产 :3000 / 测试 :3001）
 * - 输入框内不要 placeholder / 不要内嵌提示 div
 * - 只在输入卡片（.chat-mod-panel）上方渲染一条「输入提示」块
 * - 禁止落到 agent-chat-shell，避免与 staging-chat wrap 竞态产生双 tip
 * - 禁止 MutationObserver 改自身 DOM，避免死循环卡死
 */
(function () {
  if (location.port !== "3000" && location.port !== "3001") return;

  const HINTS = {
    viewStrategyQuery: {
      inputId: "strategyChatInput",
      text: "输入示例：广告位ID 5118002323，或 开发者ID / 应用ID（纯数字默认=应用ID）",
    },
    viewStrategyAudit: {
      inputId: "auditChatInput",
      text: "输入示例：策略ID 查状态；或「通过/发布/驳回/撤回 + ID」；也可输入审核人 wb_xxx",
    },
    viewStrategyRenewal: {
      inputId: "renewalChatInput",
      text: "输入示例：策略ID（空格分隔，如 13938 14619）；或粘贴到期提醒（自动抽取ID）",
    },
  };

  function clearInnerHints(input) {
    if (!input) return;
    if (input.getAttribute("placeholder") !== "") {
      input.setAttribute("placeholder", "");
    }
    if (input.placeholder) input.placeholder = "";

    const inner =
      input.closest(".chat-mod-input-inner") || input.closest(".renewal-input-inner");
    if (!inner) return;
    inner.classList.remove("has-module-input-hint");
    inner.querySelectorAll(".module-input-hint").forEach((node) => node.remove());
  }

  /** 清掉该 view 下全部 tip（含 shell 残留），避免双「输入提示」 */
  function removeAllTips(viewId) {
    const root = document.getElementById(viewId);
    if (!root) return;
    root.querySelectorAll(".module-hint-slot, .module-input-tip").forEach((node) => {
      node.remove();
    });
  }

  function ensureOutsideHint(viewId, inputId, text) {
    const input = document.getElementById(inputId);
    clearInnerHints(input);

    // 只挂 chat-mod-panel；panel 未就绪则跳过，等后续 refresh
    const panel = document.querySelector(`#${viewId} .chat-mod-panel`);
    if (!panel) return false;

    const composer = panel.querySelector(".agent-chat-composer");
    if (!composer) return false;

    // 先全局去重（含 shell 上孤儿 tip），再在 panel 内重建唯一一条
    removeAllTips(viewId);

    const slot = document.createElement("div");
    slot.className = "module-hint-slot";
    panel.insertBefore(slot, composer);

    const tip = document.createElement("div");
    tip.className = "module-input-tip";
    tip.setAttribute("aria-hidden", "true");
    tip.innerHTML =
      '<span class="module-input-tip-label">输入提示</span>' +
      '<span class="module-input-tip-text"></span>';
    slot.appendChild(tip);

    const textEl = tip.querySelector(".module-input-tip-text");
    if (textEl) textEl.textContent = text;
    return true;
  }

  function refreshAll() {
    Object.keys(HINTS).forEach((viewId) => {
      const cfg = HINTS[viewId];
      ensureOutsideHint(viewId, cfg.inputId, cfg.text);
    });
  }

  function hookViewSwitch() {
    document.querySelector(".nav")?.addEventListener("click", (event) => {
      if (!event.target.closest("[data-view]")) return;
      requestAnimationFrame(refreshAll);
      setTimeout(refreshAll, 80);
    });
    const original = window.switchView;
    if (typeof original === "function" && !original.__inputHintHooked) {
      const wrapped = function () {
        const result = original.apply(this, arguments);
        requestAnimationFrame(refreshAll);
        setTimeout(refreshAll, 80);
        return result;
      };
      wrapped.__inputHintHooked = true;
      window.switchView = wrapped;
    }
  }

  function boot() {
    refreshAll();
    hookViewSwitch();
    setTimeout(refreshAll, 150);
    setTimeout(refreshAll, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
