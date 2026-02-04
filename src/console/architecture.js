const STEP_COUNT = 7;

const descriptions = [
  "",
  "The kernel is a dumb lock. It enforces constraints, tracks state, and proves everything.",
  "The kernel computes one thing: Spend Power. What you can actually spend right now.",
  "Worlds translate blockchain state into something the kernel can read.",
  "Drivers let the kernel act on reality. Transfers, trades, subscriptions.",
  "Any AI can connect. Claude, ChatGPT, apps, agents - one kernel.",
  "The Bloom Foundation stewards the protocol. Open forever.",
  "One kernel. Every client. Banking you can talk to."
];

const layerSteps = {
  interfaces: 5,
  actions: 4,
  spend: 2,
  kernel: 1,
  adapters: 3,
  blockchains: 3,
  foundation: 6
};

const state = {
  step: 1
};

const elements = {
  description: document.getElementById("archDescription"),
  stepLabel: document.getElementById("stepLabel"),
  prevButton: document.getElementById("prevStep"),
  nextButton: document.getElementById("nextStep"),
  stage: document.getElementById("diagramStage"),
  inner: document.getElementById("diagramInner"),
  svg: document.getElementById("diagramLines"),
  layers: {
    interfaces: document.querySelector('[data-layer="interfaces"]'),
    actions: document.querySelector('[data-layer="actions"]'),
    spend: document.querySelector('[data-layer="spend"]'),
    kernel: document.querySelector('[data-layer="kernel"]'),
    adapters: document.querySelector('[data-layer="adapters"]'),
    blockchains: document.querySelector('[data-layer="blockchains"]'),
    foundation: document.querySelector('[data-layer="foundation"]')
  }
};

const nodes = {
  interfaces: Array.from(document.querySelectorAll('[data-node="interface"]')),
  actions: Array.from(document.querySelectorAll('[data-node="action"]')),
  adapters: Array.from(document.querySelectorAll('[data-node="adapter"]')),
  blockchains: Array.from(document.querySelectorAll('[data-node="blockchain"]'))
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setLayerVisibility() {
  Object.entries(layerSteps).forEach(([key, minStep]) => {
    const el = elements.layers[key];
    if (!el) return;
    el.setAttribute("data-visible", state.step >= minStep ? "true" : "false");
  });
}

function updateCopy() {
  if (elements.description) {
    elements.description.textContent = descriptions[state.step] || "";
  }
  if (elements.stepLabel) {
    elements.stepLabel.textContent = `Step ${state.step} of ${STEP_COUNT}`;
  }
  if (elements.prevButton) {
    elements.prevButton.disabled = state.step === 1;
  }
  if (elements.nextButton) {
    elements.nextButton.disabled = state.step === STEP_COUNT;
  }
}

function setStep(nextStep) {
  state.step = clamp(nextStep, 1, STEP_COUNT);
  setLayerVisibility();
  updateCopy();
  layoutLayers();
  renderLines();
}

function setTop(el, value) {
  if (!el) return;
  el.style.top = `${value}px`;
}

function layoutLayers() {
  if (!elements.inner) return;
  const height = elements.inner.clientHeight;

  const gaps = {
    interfaces: 60,
    actions: 40,
    spend: 24,
    kernel: 24,
    adapters: 40
  };

  const hInterfaces = elements.layers.interfaces?.offsetHeight ?? 0;
  const hActions = elements.layers.actions?.offsetHeight ?? 0;
  const hSpend = elements.layers.spend?.offsetHeight ?? 0;
  const hKernel = elements.layers.kernel?.offsetHeight ?? 0;
  const hAdapters = elements.layers.adapters?.offsetHeight ?? 0;
  const hBlockchains = elements.layers.blockchains?.offsetHeight ?? 0;

  const total =
    hInterfaces +
    gaps.interfaces +
    hActions +
    gaps.actions +
    hSpend +
    gaps.spend +
    hKernel +
    gaps.kernel +
    hAdapters +
    gaps.adapters +
    hBlockchains;

  const extra = Math.max(0, height - total);
  const gapAboveKernel = gaps.spend + extra / 2;
  const gapBelowKernel = gaps.kernel + extra / 2;

  let current = 0;
  setTop(elements.layers.interfaces, current);
  current += hInterfaces + gaps.interfaces;
  setTop(elements.layers.actions, current);
  current += hActions + gaps.actions;
  setTop(elements.layers.spend, current);
  current += hSpend + gapAboveKernel;
  setTop(elements.layers.kernel, current);
  current += hKernel + gapBelowKernel;
  setTop(elements.layers.adapters, current);
  current += hAdapters + gaps.adapters;
  setTop(elements.layers.blockchains, current);

  const kernelTop = Number.parseFloat(elements.layers.kernel?.style.top ?? "0");
  const kernelCenter = kernelTop + hKernel / 2;
  if (elements.layers.foundation) {
    const foundationHeight = elements.layers.foundation.offsetHeight;
    elements.layers.foundation.style.top = `${kernelCenter - foundationHeight / 2}px`;
  }
}

function getPoint(el, position) {
  if (!el || !elements.inner) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  const container = elements.inner.getBoundingClientRect();
  let x = rect.left - container.left + rect.width / 2;
  let y = rect.top - container.top + rect.height / 2;
  if (position === "top") y = rect.top - container.top;
  if (position === "bottom") y = rect.bottom - container.top;
  if (position === "left") x = rect.left - container.left;
  if (position === "right") x = rect.right - container.left;
  return { x, y };
}

function curvedPath(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const offset = dx * 0.3;
  const c1 = {
    x: start.x + offset,
    y: start.y + dy * 0.4
  };
  const c2 = {
    x: end.x - offset,
    y: start.y + dy * 0.6
  };
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
}

function addLine(fragment, config) {
  if (!elements.svg) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", curvedPath(config.start, config.end));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", config.stroke);
  path.setAttribute("stroke-width", config.width ?? 2);
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-dasharray", config.dash ?? "8 4");
  if (config.opacity) {
    path.setAttribute("stroke-opacity", String(config.opacity));
  }
  if (config.animated) {
    path.classList.add(config.direction === "up" ? "flow-up" : "flow-down");
  }
  fragment.appendChild(path);
}

function renderLines() {
  if (!elements.svg || !elements.inner) return;
  const rect = elements.inner.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  elements.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  elements.svg.setAttribute("width", `${width}`);
  elements.svg.setAttribute("height", `${height}`);

  elements.svg.innerHTML = `
    <defs>
      <linearGradient id="lineGradientDown" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#E8A87C" stop-opacity="0.85" />
        <stop offset="100%" stop-color="#E8A87C" stop-opacity="0.25" />
      </linearGradient>
      <linearGradient id="lineGradientUp" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#E8A87C" stop-opacity="0.25" />
        <stop offset="100%" stop-color="#E8A87C" stop-opacity="0.85" />
      </linearGradient>
      <linearGradient id="lineGradientSoft" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#F5C9A8" stop-opacity="0.15" />
        <stop offset="100%" stop-color="#F5C9A8" stop-opacity="0.4" />
      </linearGradient>
    </defs>
  `;

  const fragment = document.createDocumentFragment();

  if (state.step >= 5) {
    const actionsRow = elements.layers.actions?.querySelector(".layer-row");
    const actionsTop = getPoint(actionsRow, "top");
    const interfacesBottom = nodes.interfaces.map((node) => getPoint(node, "bottom"));
    const maxInterfaceBottom = Math.max(...interfacesBottom.map((pt) => pt.y));
    const junction = {
      x: actionsTop.x,
      y: maxInterfaceBottom + (actionsTop.y - maxInterfaceBottom) * 0.5
    };

    interfacesBottom.forEach((point) => {
      addLine(fragment, {
        start: point,
        end: junction,
        direction: "down",
        animated: true,
        stroke: "url(#lineGradientDown)"
      });
    });

    addLine(fragment, {
      start: junction,
      end: actionsTop,
      direction: "down",
      animated: true,
      stroke: "url(#lineGradientDown)"
    });
  }

  if (state.step >= 4) {
    const spendTop = getPoint(elements.layers.spend, "top");
    const actionsBottom = nodes.actions.map((node) => getPoint(node, "bottom"));
    const minSpendTop = spendTop.y;
    const maxActionBottom = Math.max(...actionsBottom.map((pt) => pt.y));
    const junction = {
      x: spendTop.x,
      y: maxActionBottom + (minSpendTop - maxActionBottom) * 0.5
    };

    actionsBottom.forEach((point) => {
      addLine(fragment, {
        start: point,
        end: junction,
        direction: "down",
        animated: true,
        stroke: "url(#lineGradientDown)"
      });
    });

    addLine(fragment, {
      start: junction,
      end: spendTop,
      direction: "down",
      animated: true,
      stroke: "url(#lineGradientDown)"
    });
  }

  if (state.step >= 2) {
    addLine(fragment, {
      start: getPoint(elements.layers.spend, "bottom"),
      end: getPoint(elements.layers.kernel, "top"),
      direction: "down",
      animated: true,
      stroke: "url(#lineGradientDown)"
    });
  }

  if (state.step >= 3) {
    const kernelBottom = getPoint(elements.layers.kernel, "bottom");
    nodes.adapters.forEach((node) => {
      addLine(fragment, {
        start: getPoint(node, "top"),
        end: kernelBottom,
        direction: "up",
        animated: true,
        stroke: "url(#lineGradientUp)"
      });
    });

    nodes.blockchains.forEach((node, index) => {
      const adapter = nodes.adapters[index];
      if (!adapter) return;
      addLine(fragment, {
        start: getPoint(node, "top"),
        end: getPoint(adapter, "bottom"),
        direction: "up",
        animated: true,
        stroke: "url(#lineGradientUp)"
      });
    });
  }

  if (state.step >= 6) {
    if (window.innerWidth >= 640) {
      const kernelRight = getPoint(elements.layers.kernel, "right");
      const foundationLeft = getPoint(elements.layers.foundation, "left");
      addLine(fragment, {
        start: { x: kernelRight.x + 12, y: kernelRight.y },
        end: { x: foundationLeft.x - 12, y: foundationLeft.y },
        direction: "down",
        animated: false,
        stroke: "url(#lineGradientSoft)",
        dash: "6 6",
        opacity: 0.6
      });
    }
  }

  elements.svg.appendChild(fragment);
}

function handleResize() {
  layoutLayers();
  renderLines();
}

if (elements.prevButton) {
  elements.prevButton.addEventListener("click", () => setStep(state.step - 1));
}

if (elements.nextButton) {
  elements.nextButton.addEventListener("click", () => setStep(state.step + 1));
}

window.addEventListener("resize", handleResize);

if (window.ResizeObserver && elements.inner) {
  const observer = new ResizeObserver(handleResize);
  observer.observe(elements.inner);
}

setStep(state.step);
