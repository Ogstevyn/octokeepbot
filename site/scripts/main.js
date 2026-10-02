(() => {
  const status = document.getElementById("copy-status");

  // Transcripts have no separator between cells; copy as "speaker: message".
  const textOf = (el) => {
    if (!el.classList.contains("chat")) return el.textContent.trim();
    const lines = [];
    let speaker = null;
    for (const node of el.children) {
      if (node.classList.contains("who")) speaker = node.textContent;
      else if (node.classList.contains("gap")) lines.push("", node.textContent, "");
      else {
        lines.push(`${speaker}: ${node.textContent.replace(/\n/g, "\n  ")}`);
        speaker = null;
      }
    }
    return lines.join("\n").trim();
  };

  const fallbackCopy = (text) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    area.remove();
    return ok;
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return fallbackCopy(text);
    }
  };

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-copy], [data-copy-target]");
    if (!btn) return;
    const target = btn.dataset.copyTarget && document.getElementById(btn.dataset.copyTarget);
    const text = btn.dataset.copy || (target ? textOf(target) : "");
    if (!text) return;
    const ok = await copy(text);
    if (status) status.textContent = ok ? "Copied" : "Copy failed";
    if (!ok) return;
    btn.classList.add("is-copied");
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove("is-copied");
      if (status) status.textContent = "";
    }, 1600);
  });

  // WAI-ARIA tabs: arrows, Home and End move and activate.
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
    };
    list.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab, false);
    });
    list.addEventListener("keydown", (event) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const next = {
        ArrowRight: (i + 1) % tabs.length,
        ArrowLeft: (i - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next], true);
    });
  }
})();
