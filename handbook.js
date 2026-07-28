/**
 * 产品手册 — Mermaid 渲染 + 图表点击放大 + 目录滚动高亮
 */
(function () {
  "use strict";

  let _zoomBound = false;
  let _tocObserver = null;

  function openDiagramLightbox(sourceEl) {
    const modal = document.getElementById("handbookDiagramModal");
    const body = document.getElementById("handbookDiagramModalBody");
    const svg = sourceEl && sourceEl.querySelector("svg");
    if (!svg || !modal || !body) return;

    body.innerHTML = "";
    const clone = svg.cloneNode(true);
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    clone.style.width = "100%";
    clone.style.height = "auto";
    clone.style.maxWidth = "none";
    body.appendChild(clone);

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeDiagramLightbox() {
    const modal = document.getElementById("handbookDiagramModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    const body = document.getElementById("handbookDiagramModalBody");
    if (body) body.innerHTML = "";
  }

  function bindDiagramZoom() {
    document.querySelectorAll(".handbook-content .mermaid").forEach((el) => {
      if (el.closest(".handbook-diagram-wrap")) return;
      if (!el.querySelector("svg")) return;

      const wrap = document.createElement("div");
      wrap.className = "handbook-diagram-wrap";
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-label", "点击放大查看流程图");
      wrap.title = "点击放大";

      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);

      const hint = document.createElement("span");
      hint.className = "handbook-diagram-hint";
      hint.textContent = "点击放大";
      wrap.appendChild(hint);

      wrap.addEventListener("click", () => openDiagramLightbox(el));
      wrap.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDiagramLightbox(el);
        }
      });
    });

    if (_zoomBound) return;
    _zoomBound = true;

    const closeBtn = document.getElementById("handbookDiagramModalClose");
    const backdrop = document.getElementById("handbookDiagramModalBackdrop");
    if (closeBtn) closeBtn.addEventListener("click", closeDiagramLightbox);
    if (backdrop) backdrop.addEventListener("click", closeDiagramLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const modal = document.getElementById("handbookDiagramModal");
      if (modal && !modal.classList.contains("hidden")) closeDiagramLightbox();
    });
  }

  function setActiveTocLink(id) {
    if (!id) return;
    document.querySelectorAll(".handbook-toc-list a").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("href") === `#${id}`);
    });
  }

  function initTocSpy() {
    const sections = Array.from(document.querySelectorAll("#viewHandbook .handbook-section[id]"));
    const tocLinks = document.querySelectorAll(".handbook-toc-list a");
    if (!sections.length || !tocLinks.length) return;

    const root = document.querySelector(".content") || null;

    if (_tocObserver) {
      _tocObserver.disconnect();
      _tocObserver = null;
    }

    _tocObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0] && visible[0].target.id) {
          setActiveTocLink(visible[0].target.id);
        }
      },
      {
        root,
        rootMargin: "-12% 0px -68% 0px",
        threshold: [0, 0.1, 0.25],
      }
    );

    sections.forEach((sec) => _tocObserver.observe(sec));

    tocLinks.forEach((link) => {
      if (link.dataset.tocBound) return;
      link.dataset.tocBound = "1";
      link.addEventListener("click", () => {
        const id = (link.getAttribute("href") || "").replace(/^#/, "");
        setActiveTocLink(id);
      });
    });

    const hash = (location.hash || "").replace(/^#/, "");
    if (hash) setActiveTocLink(hash);
    else if (sections[0]) setActiveTocLink(sections[0].id);
  }

  async function renderHandbookMermaid() {
    if (typeof mermaid === "undefined") return;
    const nodes = document.querySelectorAll(".handbook-content .mermaid:not([data-processed])");
    if (nodes.length === 0) {
      bindDiagramZoom();
      return;
    }
    try {
      await mermaid.run({ nodes: Array.from(nodes) });
    } catch (err) {
      console.error("[handbook] mermaid 渲染失败:", err);
    }
    bindDiagramZoom();
  }

  function initHandbook() {
    initTocSpy();
    if (typeof mermaid === "undefined") return;
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "loose",
    });
    renderHandbookMermaid();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHandbook);
  } else {
    initHandbook();
  }

  // 切到手册视图时重新校准目录高亮（内容区滚动容器可能已就绪）
  document.querySelectorAll('.nav-item[data-view="handbook"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      window.setTimeout(initTocSpy, 80);
    });
  });
})();
