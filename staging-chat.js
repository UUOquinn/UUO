/**
 * 聊天模块布局优化（3000/3001 共用）
 * - 审核人搜索条移到聊天区左上角
 * - 搜索 + 输入合并为底部输入卡片
 * - 执行流程独立到上方浅底滚动区（红圈位置）
 * - 去掉欢迎说明文案（由框外「输入提示」承担）
 */
(function () {
  if (location.port !== "3001" && location.port !== "3000") return;

  const MODULE_VIEWS = [
    "viewStrategyQuery",
    "viewStrategyAudit",
    "viewStrategyRenewal",
  ];

  const COMPACT_VIEWS = new Set([
    "strategy-query",
    "strategy-audit",
    "strategy-renewal",
    "home",
  ]);

  function getActiveView() {
    return document.querySelector(".nav-item.active[data-view]")?.dataset.view || "home";
  }

  function syncCompactMode() {
    document.documentElement.classList.toggle(
      "staging-compact-chat",
      COMPACT_VIEWS.has(getActiveView())
    );
  }

  /** 删除欢迎/说明类 system 气泡，避免再出现在输入卡片里 */
  function clearWelcomeHints(viewId) {
    const msgs =
      document.querySelector(`#${viewId} .module-flow-results`) ||
      document.querySelector(`#${viewId} .agent-chat-messages`);
    if (!msgs) return;
    msgs.querySelectorAll(".agent-msg-system, .agent-msg-assistant").forEach((node) => {
      if (node.querySelector(".module-hint-line")) {
        node.remove();
        return;
      }
      // 初始欢迎说明（未执行任务前的静态说明）也清掉
      if (node.classList.contains("agent-msg-system") && !node.dataset.keepFlow) {
        const text = (node.textContent || "").trim();
        if (
          /查状态|输入策略 ID 延期|输入开发者|请输入策略 ID|请输入需要延期|自动化执行流程/.test(
            text
          )
        ) {
          node.remove();
        }
      }
    });
  }

  function relocateAuditSearch() {
    const shell = document.querySelector("#viewStrategyAudit .agent-chat-shell");
    const combobox = document.getElementById("auditReviewerCombobox");
    const messages = document.getElementById("auditChatMessages");
    if (!shell || !combobox || !messages || document.getElementById("auditModuleSearchBar")) return;

    const bar = document.createElement("div");
    bar.id = "auditModuleSearchBar";
    bar.className = "module-search-bar module-search-bar-top";
    bar.innerHTML = '<span class="module-search-label">审核人搜索</span>';
    shell.insertBefore(bar, messages);
    bar.appendChild(combobox);
  }

  function splitResultsFromInput(viewId) {
    const shell = document.querySelector(`#${viewId} .agent-chat-shell`);
    const panel = shell?.querySelector(".chat-mod-panel");
    const messages = shell?.querySelector(".agent-chat-messages");
    if (!shell || !panel || !messages) return;

    if (panel.contains(messages)) {
      shell.insertBefore(messages, panel);
    }

    messages.classList.add("module-flow-results");
    panel.classList.add("module-input-block");
  }

  function syncFlowVisibility(viewId) {
    const messages = document.querySelector(`#${viewId} .module-flow-results`);
    if (!messages) return;

    const hasFlow = [...messages.querySelectorAll(".agent-msg")].some((msg) => {
      if (msg.classList.contains("agent-msg-user")) return false;
      if (msg.querySelector(".module-hint-line")) return false;
      return (msg.textContent || "").trim().length > 0;
    });

    messages.classList.toggle("is-empty", !hasFlow);
    // 双保险：空态直接隐藏，避免被其它样式盖掉
    if (!hasFlow) {
      messages.setAttribute("hidden", "");
      messages.style.display = "none";
    } else {
      messages.removeAttribute("hidden");
      messages.style.display = "";
    }
  }

  function observeFlowResults(viewId) {
    const messages = document.querySelector(`#${viewId} .module-flow-results`);
    if (!messages || messages.dataset.flowObserved === "1") return;

    messages.dataset.flowObserved = "1";
    // 只根据子节点增删切换 is-empty，不做 DOM 回写，避免死循环
    const observer = new MutationObserver(() => syncFlowVisibility(viewId));
    observer.observe(messages, { childList: true, subtree: false });
    syncFlowVisibility(viewId);
  }

  function setupFlowLayout() {
    MODULE_VIEWS.forEach((viewId) => {
      splitResultsFromInput(viewId);
      clearWelcomeHints(viewId);
      observeFlowResults(viewId);
      syncFlowVisibility(viewId);
    });
  }

  function wrapChatPanels() {
    MODULE_VIEWS.forEach((viewId) => {
      const shell = document.querySelector(`#${viewId} .agent-chat-shell`);
      if (!shell || shell.querySelector(".chat-mod-panel")) return;

      const messages = shell.querySelector(".agent-chat-messages");
      const composer = shell.querySelector(".agent-chat-composer");
      if (!messages || !composer) return;

      const panel = document.createElement("div");
      panel.className = "chat-mod-panel";

      const searchBar =
        viewId === "viewStrategyAudit" ? document.getElementById("auditModuleSearchBar") : null;

      shell.insertBefore(panel, messages);
      if (searchBar && searchBar.parentNode === shell) {
        panel.appendChild(searchBar);
      }
      panel.appendChild(messages);
      panel.appendChild(composer);
    });
  }

  function hookViewSwitch() {
    const nav = document.querySelector(".nav");
    nav?.addEventListener("click", (event) => {
      if (event.target.closest("[data-view]")) {
        requestAnimationFrame(() => {
          syncCompactMode();
          setupFlowLayout();
        });
      }
    });

    const original = window.switchView;
    if (typeof original === "function" && !original.__stagingCompactHooked) {
      const wrapped = function (view) {
        const result = original.apply(this, arguments);
        syncCompactMode();
        requestAnimationFrame(setupFlowLayout);
        setTimeout(setupFlowLayout, 50);
        return result;
      };
      wrapped.__stagingCompactHooked = true;
      window.switchView = wrapped;
    }
  }

  function init() {
    relocateAuditSearch();
    wrapChatPanels();
    setupFlowLayout();
    hookViewSwitch();
    syncCompactMode();
    setTimeout(setupFlowLayout, 80);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
