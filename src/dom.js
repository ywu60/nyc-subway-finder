// Small DOM helpers shared by the UI modules.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

export function badge(route) {
  return el(
    "span",
    {
      class: "badge",
      style: { background: route.color, color: route.text },
      "aria-label": `${route.name} (${route.label})`,
    },
    route.label,
  );
}
