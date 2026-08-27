document.documentElement.classList.add("js");

document.querySelectorAll(".site-header").forEach(header => {
  const toggle = header.querySelector(".menu-toggle");
  const navigation = header.querySelector("nav");
  if (!toggle || !navigation) return;

  const closeMenu = () => {
    navigation.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", () => {
    const isOpen = navigation.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
  navigation.querySelectorAll("a").forEach(link => link.addEventListener("click", closeMenu));
  document.addEventListener("click", event => {
    if (!header.contains(event.target)) closeMenu();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeMenu();
  });
});

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

async function copyText(button, value) {
  try {
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1400);
  } catch {
    button.textContent = "Select & copy";
  }
}

document.querySelectorAll("[data-copy]").forEach(button => {
  button.addEventListener("click", () => copyText(button, button.dataset.copy));
});

const codeGuide = document.querySelector("[data-code-guide]");
if (codeGuide) {
  const tabs = [...codeGuide.querySelectorAll("[data-code-tab]")];
  const panels = [...codeGuide.querySelectorAll("[data-code-panel]")];
  const filename = codeGuide.querySelector("[data-code-filename]");
  const progress = codeGuide.querySelector("[data-code-progress]");
  const copyButton = codeGuide.querySelector("[data-copy-code]");

  function showCodePanel(name) {
    tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.codeTab === name));
    panels.forEach(panel => { panel.hidden = panel.dataset.codePanel !== name; });
    const activePanel = panels.find(panel => panel.dataset.codePanel === name);
    filename.textContent = activePanel.dataset.filename;
    progress.textContent = `Step ${tabs.findIndex(tab => tab.dataset.codeTab === name) + 1} of ${tabs.length}`;
  }

  tabs.forEach(tab => tab.addEventListener("click", () => showCodePanel(tab.dataset.codeTab)));
  copyButton.addEventListener("click", () => {
    const activePanel = panels.find(panel => !panel.hidden);
    copyText(copyButton, activePanel.querySelector("code").textContent);
  });
}

const demo = document.querySelector("[data-real-demo]");
if (demo) {
  const realApp = demo.querySelector(".real-app");
  const launcher = demo.querySelector("[data-assistant-open]");
  const panel = demo.querySelector("[data-assistant-panel]");
  const content = demo.querySelector("[data-assistant-content]");
  const composer = demo.querySelector("[data-assistant-composer]");
  const textarea = composer.querySelector("textarea");
  const chip = demo.querySelector("[data-selection-chip]");
  const chipLabel = demo.querySelector("[data-selection-chip-label]");
  const hud = demo.querySelector("[data-selection-hud]");
  const guideCopy = demo.querySelector("[data-guide-copy]");
  const guideSteps = [...demo.querySelectorAll("[data-guide-step]")];
  const selectableElements = [...demo.querySelectorAll("[data-selectable]")];
  const viewLinks = [...demo.querySelectorAll("[data-demo-view]")];
  const appMenuToggle = demo.querySelector("[data-app-menu-toggle]");
  const appMenu = demo.querySelector("[data-app-menu]");
  const viewTitle = demo.querySelector("[data-view-title]");
  const viewKicker = demo.querySelector("[data-view-kicker]");
  const viewSubtitle = demo.querySelector("[data-view-subtitle]");
  const listTitle = demo.querySelector("[data-list-title]");
  const appRows = [...demo.querySelectorAll(".app-row")];
  const statCards = [...demo.querySelectorAll(".app-stats article")];
  const detailTitle = demo.querySelector("[data-detail-title]");
  const detailCopy = demo.querySelector("[data-detail-copy]");
  let selectedLabel = "";
  let loadingTimer;

  function closeAppMenu() {
    appMenu.classList.remove("open");
    appMenuToggle.setAttribute("aria-expanded", "false");
    appMenuToggle.setAttribute("aria-label", "Open AcmeDesk navigation");
  }

  const guide = {
    1: "Open the assistant using the floating button in the bottom-right corner.",
    2: "Click Select element, then choose something inside the screen.",
    3: "Ask a question and send it. Your selection will be attached automatically.",
    4: "Finally, check the answer, its sources and limitations.",
  };

  const views = {
    requests: {
      kicker: "Operations workspace", title: "Service requests", subtitle: "Track and resolve workplace requests.", list: "Recent requests",
      stats: [["Open", "24", "3 new today"], ["Waiting", "7", "Needs review"], ["Resolved", "86%", "Last 30 days"]],
      rows: [["#1048", "Replace meeting-room display", "Facilities · North office", "Blocked", "blocked"], ["#1047", "Onboard a new support agent", "People ops · Remote", "Review", "review"], ["#1046", "Renew analytics workspace", "Data · West office", "Open", "open"]],
      detail: ["Approval requirements", "A site readiness check is required for equipment requests."]
    },
    assets: {
      kicker: "Asset workspace", title: "Workplace assets", subtitle: "Review ownership, health and upcoming service.", list: "Recently updated assets",
      stats: [["Active", "148", "Across 4 sites"], ["Service due", "9", "Next 30 days"], ["Assigned", "92%", "Current coverage"]],
      rows: [["#A-219", "Meeting-room display", "North office · Room 4A", "Service", "blocked"], ["#A-204", "Support laptop pool", "Remote team · 12 devices", "Assigned", "review"], ["#A-197", "Analytics kiosk", "West office · Lobby", "Active", "open"]],
      detail: ["Asset lifecycle", "Service status is calculated from maintenance and assignment records."]
    },
    reports: {
      kicker: "Insights workspace", title: "Operational reports", subtitle: "Follow service quality and workload trends.", list: "Available reports",
      stats: [["Dashboards", "12", "Shared with team"], ["Scheduled", "4", "Weekly delivery"], ["Freshness", "2h", "Latest refresh"]],
      rows: [["#R-12", "Request cycle time", "Last 30 days · All teams", "Ready", "open"], ["#R-09", "Asset service forecast", "Next quarter · Facilities", "Scheduled", "review"], ["#R-03", "Workspace adoption", "Current month · All sites", "Draft", "blocked"]],
      detail: ["Report context", "Reports use the active workspace scope and the user’s visible teams."]
    },
    settings: {
      kicker: "Administration", title: "Workspace settings", subtitle: "Configure shared rules and application behavior.", list: "Configuration areas",
      stats: [["Members", "38", "5 administrators"], ["Policies", "6", "All enforced"], ["Integrations", "4", "Healthy"]],
      rows: [["#S-01", "Assistant access policy", "Roles and user access", "Active", "open"], ["#S-02", "Notification rules", "Email and workspace events", "Review", "review"], ["#S-03", "Workspace profile", "Name, locale and defaults", "Updated", "open"]],
      detail: ["Administrative scope", "Only authorized administrators can change workspace configuration."]
    }
  };

  function setView(name) {
    const view = views[name];
    if (!view) return;
    viewLinks.forEach(link => link.classList.toggle("active", link.dataset.demoView === name));
    viewKicker.textContent = view.kicker;
    viewTitle.textContent = view.title;
    viewSubtitle.textContent = view.subtitle;
    listTitle.textContent = view.list;
    detailTitle.textContent = view.detail[0];
    detailCopy.textContent = view.detail[1];
    statCards.forEach((card, index) => {
      const [label, value, note] = view.stats[index];
      card.querySelector("small").textContent = label;
      card.querySelector("strong").textContent = value;
      card.querySelector("span").textContent = note;
      card.dataset.selectionLabel = `Metric · ${label}: ${value}`;
    });
    appRows.forEach((row, index) => {
      const [id, title, meta, status, statusClass] = view.rows[index];
      row.querySelector(":scope > span").textContent = id;
      row.querySelector("div strong").textContent = title;
      row.querySelector("div small").textContent = meta;
      const statusElement = row.querySelector(":scope > b");
      statusElement.textContent = status;
      statusElement.className = `status ${statusClass}`;
      row.dataset.selectionLabel = `${id} · ${title}`;
    });
    clearSelection();
  }

  function setGuide(step) {
    guideCopy.textContent = guide[step];
    guideSteps.forEach(item => item.classList.toggle("active", Number(item.dataset.guideStep) === step));
  }

  function welcomeMarkup() {
    return `<div class="real-ai-welcome"><span>✦</span><div><strong>How can I help?</strong><p>Ask about this page or select a specific element.</p></div></div>`;
  }

  function openPanel() {
    launcher.hidden = true;
    panel.hidden = false;
    setGuide(selectedLabel ? 3 : 2);
  }

  function closePanel() {
    panel.hidden = true;
    launcher.hidden = false;
  }

  function cancelSelection() {
    realApp.classList.remove("selection-mode");
    hud.hidden = true;
    selectableElements.forEach(element => element.classList.remove("selected"));
    openPanel();
  }

  function startSelection() {
    closePanel();
    launcher.hidden = true;
    realApp.classList.add("selection-mode");
    hud.hidden = false;
    setGuide(2);
  }

  function selectElement(element) {
    if (!realApp.classList.contains("selection-mode")) return;
    closeAppMenu();
    selectedLabel = element.dataset.selectionLabel;
    selectableElements.forEach(item => item.classList.toggle("selected", item === element));
    realApp.classList.remove("selection-mode");
    hud.hidden = true;
    chipLabel.textContent = selectedLabel;
    chip.hidden = false;
    content.innerHTML = `<article class="real-selection-event"><span>✦</span><div><small>Selected element</small><strong>${escapeHtml(selectedLabel)}</strong></div></article>`;
    openPanel();
    textarea.value = selectedLabel.startsWith("Request #1048") ? "Why is this request blocked?" : "What should I know about this element?";
    setGuide(3);
    textarea.focus();
  }

  function clearSelection() {
    selectedLabel = "";
    chip.hidden = true;
    chipLabel.textContent = "";
    selectableElements.forEach(element => element.classList.remove("selected"));
  }

  function ask(question) {
    const normalizedQuestion = question.trim() || (selectedLabel ? "What should I know about this element?" : "What can I do on this page?");
    const selection = selectedLabel
      ? `<article class="real-selection-event"><span>✦</span><div><small>Selected element</small><strong>${escapeHtml(selectedLabel)}</strong></div></article>`
      : "";
    content.innerHTML = `${selection}<article class="real-ai-message real-ai-user">${escapeHtml(normalizedQuestion)}</article><article class="real-ai-message real-ai-progress"><div><span class="real-ai-dots"><i></i><i></i><i></i></span><span data-progress-label>Reading the page…</span></div></article>`;
    content.scrollTop = content.scrollHeight;
    setGuide(3);

    const progressLabel = content.querySelector("[data-progress-label]");
    const phases = ["Reading the page…", "Thinking…", "Writing the answer…", "Checking the answer…"];
    let phase = 0;
    window.clearInterval(loadingTimer);
    loadingTimer = window.setInterval(() => {
      phase += 1;
      if (phase < phases.length) progressLabel.textContent = phases[phase];
    }, 320);

    window.setTimeout(() => {
      window.clearInterval(loadingTimer);
      const answer = selectedLabel.startsWith("Request #1048")
        ? {
            title: "A site readiness check is still required",
            summary: "Request #1048 is blocked because the mounting surface and power access have not yet been confirmed. Those checks are required before equipment can be assigned and installation can be scheduled.",
            detail: "The assistant uses the selected request as focused context while keeping the page workflow in view. That makes the explanation specific to this item without losing the rules that control the wider process.",
            steps: ["Schedule the site check.", "Attach the completed checklist.", "Move the request back to Review."],
            warning: "This demo answer is simulated and does not use live application data.",
            limitation: "The demo does not check live inventory, scheduling or permissions."
          }
        : {
            title: "Manage service requests from this page",
            summary: "This workspace brings the main request-management actions into one view. You can review the queue, filter by status, inspect a request and create a new one without leaving the page.",
            detail: "Because no specific element is selected, the assistant answers from the page as a whole. Selecting a row, metric or action narrows the context and produces a more focused explanation.",
            steps: ["Open a request for details.", "Use Filter to narrow the queue.", "Select an element for a focused explanation."],
            warning: "This demo answer is simulated and does not use live application data.",
            limitation: "The demo does not check live records, permissions or application rules."
          };

      content.innerHTML = `${selection}<article class="real-ai-message real-ai-user">${escapeHtml(normalizedQuestion)}</article><article class="real-ai-message real-ai-answer"><h3>${answer.title}</h3><p>${answer.summary}</p><p>${answer.detail}</p><h4>Suggested next steps</h4><ol>${answer.steps.map(step => `<li>${step}</li>`).join("")}</ol><p class="real-ai-warning">⚠ ${answer.warning}</p><footer><span class="real-confidence"><i class="medium"></i>Reliability: 74%</span><small class="real-confidence-note">Based on the available information; verify before acting.</small><small>${answer.limitation}</small></footer></article>`;
      content.scrollTop = content.scrollHeight;
      setGuide(4);
    }, 1400);
  }

  function resetDemo() {
    window.clearInterval(loadingTimer);
    closeAppMenu();
    setView("requests");
    selectedLabel = "";
    realApp.classList.remove("selection-mode");
    selectableElements.forEach(element => element.classList.remove("selected"));
    hud.hidden = true;
    panel.hidden = true;
    launcher.hidden = false;
    chip.hidden = true;
    chipLabel.textContent = "";
    textarea.value = "";
    content.innerHTML = welcomeMarkup();
    setGuide(1);
  }

  launcher.addEventListener("click", openPanel);
  demo.querySelector("[data-assistant-close]").addEventListener("click", closePanel);
  demo.querySelector("[data-start-selection]").addEventListener("click", startSelection);
  demo.querySelector("[data-cancel-selection]").addEventListener("click", cancelSelection);
  demo.querySelector("[data-clear-selection]").addEventListener("click", clearSelection);
  demo.querySelector("[data-new-conversation]").addEventListener("click", () => {
    clearSelection();
    content.innerHTML = welcomeMarkup();
    setGuide(2);
  });
  demo.querySelector("[data-demo-reset]").addEventListener("click", resetDemo);
  appMenuToggle.addEventListener("click", () => {
    const isOpen = appMenu.classList.toggle("open");
    appMenuToggle.setAttribute("aria-expanded", String(isOpen));
    appMenuToggle.setAttribute("aria-label", isOpen ? "Close AcmeDesk navigation" : "Open AcmeDesk navigation");
  });
  viewLinks.forEach(link => link.addEventListener("click", event => {
    if (realApp.classList.contains("selection-mode")) return;
    event.preventDefault();
    setView(link.dataset.demoView);
    closeAppMenu();
  }));
  demo.querySelectorAll(".app-toolbar > div button").forEach(button => button.addEventListener("click", () => {
    if (realApp.classList.contains("selection-mode")) return;
    demo.querySelectorAll(".app-toolbar > div button").forEach(item => item.classList.toggle("active", item === button));
  }));
  selectableElements.forEach(element => element.addEventListener("click", event => {
    if (!realApp.classList.contains("selection-mode")) return;
    event.preventDefault();
    event.stopPropagation();
    selectElement(element);
  }));
  composer.addEventListener("submit", event => {
    event.preventDefault();
    const question = textarea.value;
    textarea.value = "";
    ask(question);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && realApp.classList.contains("selection-mode")) cancelSelection();
    if (event.key === "Escape") closeAppMenu();
  });
  document.addEventListener("click", event => {
    if (!appMenu.contains(event.target) && !appMenuToggle.contains(event.target)) closeAppMenu();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeAppMenu();
  });
}
