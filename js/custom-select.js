/**
 * Custom Select Component
 * Wraps native <select> elements with an elegant, accessible, custom UI
 * while preserving 100% native event dispatching and dynamic option updates.
 */

export function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customized === "true") return selectEl?._customSelect;

  selectEl.dataset.customized = "true";

  // Container
  const wrapper = document.createElement("div");
  wrapper.className = "custom-select-wrapper";

  // Hide native select accessibly
  selectEl.classList.add("native-select-hidden");
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);

  // Trigger Button
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const labelSpan = document.createElement("span");
  labelSpan.className = "custom-select-label";

  const chevron = document.createElement("span");
  chevron.className = "custom-select-chevron";
  chevron.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
    </svg>
  `;

  trigger.appendChild(labelSpan);
  trigger.appendChild(chevron);
  wrapper.appendChild(trigger);

  // Dropdown Menu
  const dropdown = document.createElement("div");
  dropdown.className = "custom-select-dropdown";
  dropdown.setAttribute("role", "listbox");

  // Options List
  const optionsList = document.createElement("div");
  optionsList.className = "custom-select-options";
  dropdown.appendChild(optionsList);
  wrapper.appendChild(dropdown);

  let isOpen = false;

  function toggleOpen(show) {
    isOpen = show !== undefined ? show : !isOpen;
    if (isOpen) {
      // Close any other open custom selects first
      document.querySelectorAll(".custom-select-wrapper.is-open").forEach((el) => {
        if (el !== wrapper) el.classList.remove("is-open");
      });
      wrapper.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      
      // Auto-scroll to selected option
      const selected = optionsList.querySelector(".custom-select-option.is-selected");
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    } else {
      wrapper.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  function syncFromNative() {
    optionsList.innerHTML = "";
    const options = Array.from(selectEl.options);
    const selectedIndex = selectEl.selectedIndex >= 0 ? selectEl.selectedIndex : 0;
    const currentOpt = selectEl.options[selectedIndex];

    const currentText = currentOpt ? currentOpt.textContent.trim() : (selectEl.placeholder || "Select…");
    labelSpan.textContent = currentText;

    if (!selectEl.value || selectEl.value === "") {
      labelSpan.classList.add("is-placeholder");
    } else {
      labelSpan.classList.remove("is-placeholder");
    }

    if (selectEl.disabled) {
      trigger.disabled = true;
      wrapper.classList.add("is-disabled");
    } else {
      trigger.disabled = false;
      wrapper.classList.remove("is-disabled");
    }

    options.forEach((opt, idx) => {
      const isSelected = idx === selectedIndex;
      const optBtn = document.createElement("div");
      optBtn.className = `custom-select-option ${isSelected ? "is-selected" : ""} ${!opt.value ? "is-empty-val" : ""}`;
      optBtn.setAttribute("role", "option");
      optBtn.setAttribute("aria-selected", isSelected ? "true" : "false");
      optBtn.dataset.value = opt.value;
      optBtn.dataset.index = idx;

      optBtn.innerHTML = `
        <span class="custom-select-option-text">${opt.textContent}</span>
        <svg class="custom-select-check" width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
        </svg>
      `;

      optBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectEl.value !== opt.value) {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncFromNative();
        toggleOpen(false);
        trigger.focus();
      });

      optionsList.appendChild(optBtn);
    });
  }

  // Trigger click
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (selectEl.disabled) return;
    toggleOpen();
  });

  // Native select change event listener (e.g. if code modifies .value and fires change)
  selectEl.addEventListener("change", () => {
    syncFromNative();
  });

  // MutationObserver to watch dynamic option additions/removals or disabled changes
  const observer = new MutationObserver(() => {
    syncFromNative();
  });

  observer.observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "value"]
  });

  // Global document click to close dropdown
  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) {
      toggleOpen(false);
    }
  });

  // Keyboard navigation
  wrapper.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      toggleOpen(false);
      trigger.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!isOpen) {
        toggleOpen(true);
        e.preventDefault();
      }
    }
  });

  // Initial populate
  syncFromNative();

  const controller = {
    sync: syncFromNative,
    destroy: () => {
      observer.disconnect();
      wrapper.replaceWith(selectEl);
      selectEl.classList.remove("native-select-hidden");
      delete selectEl.dataset.customized;
    }
  };

  selectEl._customSelect = controller;
  return controller;
}

export function initAllCustomSelects(root = document) {
  const selects = root.querySelectorAll("select:not([data-customized])");
  selects.forEach((sel) => initCustomSelect(sel));
}
