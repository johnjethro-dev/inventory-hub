const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");
const toastRegion = document.querySelector("#toast-region");
let startedOnBackdrop = false;

const state = {
  data: null,
  view: "overview",
  search: "",
  filter: "all",
};

const labels = {
  overview: "Overview",
  inventory: "Consumables",
  assets: "Company assets",
  requests: "Requests",
  admin: "Administration",
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

const initials = (name) => String(name || "IH").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const formatDate = (value, withTime = false) => value ? new Intl.DateTimeFormat("en-PH", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(new Date(value)) : "—";
const formatNumber = (value) => new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 }).format(Number(value) || 0);
const formatMoney = (value) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(Number(value) || 0);
const isStaff = () => ["custodian", "admin"].includes(state.data?.user.role);
const isApprover = () => ["manager", "admin"].includes(state.data?.user.role);
const actionLabel = (value) => ({
  seed: "initialized",
  login: "signed in to",
  create: "created",
  receive: "received",
  adjust: "adjusted",
  approve: "approved",
  reject: "rejected",
  issue: "issued",
  assign: "assigned",
  return: "returned",
  cancel: "cancelled",
}[value] || value.replaceAll("_", " "));

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.body && typeof options.body !== "string" ? { "content-type": "application/json" } : {}), ...(options.method && options.method !== "GET" ? { "x-requested-with": "inventory-hub" } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok && response.status !== 207) throw Object.assign(new Error(payload.error || "The request failed."), { status: response.status, payload });
  return payload;
}

async function refresh(showError = true) {
  try {
    state.data = await api("/api/dashboard");
    render();
    if (state.data.user.mustChangePassword) openPasswordModal(true);
  } catch (error) {
    if (error.status === 401) renderLogin();
    else if (showError) toast(error.message, "error");
  }
}

function renderLogin() {
  state.data = null;
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="login-title">
        <div class="login-brand"><div class="brand-lockup"><span class="brand-swoop" aria-hidden="true"></span><span class="brand-copy"><strong>SBDMC</strong><small>Inventory Hub</small></span></div></div>
        <form class="login-card" data-form="login">
          <h1 id="login-title">Sign in</h1>
          <div class="form-error hidden" data-error></div>
          <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="username" value="admin@inventory.local" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" value="ChangeMe123!" required></div>
          <button class="button primary block" type="submit">Sign in</button>
          <details class="setup-note"><summary>First-time setup</summary><p>Use <strong>admin@inventory.local</strong> and <strong>ChangeMe123!</strong>. You’ll be asked to set a new password.</p></details>
        </form>
      </section>
    </main>`;
}

function navItem(view, icon) {
  return `<button class="nav-button ${state.view === view ? "active" : ""}" data-view="${view}"><span class="nav-icon">${icon}</span>${labels[view]}</button>`;
}

function render() {
  if (!state.data) return renderLogin();
  const { user, notifications } = state.data;
  const unread = notifications.filter((item) => !item.read_at).length;
  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar" id="sidebar">
        <div class="login-brand"><div class="brand-lockup"><span class="brand-swoop" aria-hidden="true"></span><span class="brand-copy"><strong>SBDMC</strong><small>Inventory Hub</small></span></div></div>
        <nav class="nav" aria-label="Main navigation">
          ${navItem("overview", "⌂")}${navItem("inventory", "▦")}${navItem("assets", "◇")}${navItem("requests", "✓")}${user.role === "admin" ? navItem("admin", "⚙") : ""}
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip"><div class="avatar">${initials(user.name)}</div><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role)}</small></div></div>
          <button class="nav-button" data-action="change-password"><span class="nav-icon">••</span>Change password</button>
          <button class="nav-button" data-action="logout"><span class="nav-icon">↗</span>Sign out</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div class="topbar-title"><button class="mobile-menu" data-action="menu" aria-label="Open menu">☰</button><h1>${labels[state.view]}</h1></div>
          <div class="top-actions"><button class="notification-button" data-action="notifications" aria-label="Notifications">◎${unread ? `<span class="notification-dot"></span>` : ""}</button></div>
        </header>
        <div class="content">${renderView()}</div>
      </main>
    </div>`;
}

function renderView() {
  if (state.view === "inventory") return renderInventory();
  if (state.view === "assets") return renderAssets();
  if (state.view === "requests") return renderRequests();
  if (state.view === "admin") return renderAdmin();
  return renderOverview();
}

function renderWelcome(title, description, actions = "") {
  return `<section class="welcome"><div><div class="eyebrow">${new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</div><h2>${title}</h2><p>${description}</p></div><div class="quick-actions">${actions}</div></section>`;
}

function statCard(label, value, hint, tone = "") {
  return `<article class="stat-card ${tone}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-hint">${hint}</div></article>`;
}

function requestName(request) {
  return request.type === "consumable" ? `${request.item_code} · ${request.item_name}` : `${request.asset_category} asset`;
}

function requestRows(requests, limit) {
  const list = limit ? requests.slice(0, limit) : requests;
  if (!list.length) return `<tr><td colspan="6"><div class="empty"><strong>No requests here</strong>New requests will appear as they move through the workflow.</div></td></tr>`;
  return list.map((request) => `<tr>
    <td><span class="code">#${request.id}</span></td>
    <td><span class="cell-title">${escapeHtml(requestName(request))}</span><span class="cell-sub">${escapeHtml(request.requester_name)}</span></td>
    <td>${request.type === "consumable" ? `${formatNumber(request.quantity_issued)} / ${formatNumber(request.quantity_requested)}` : escapeHtml(request.assignment_type || "—")}</td>
    <td><span class="badge ${request.status}">${request.status.replaceAll("_", " ")}</span></td>
    <td>${formatDate(request.created_at)}</td>
    <td><div class="row-actions">${requestActions(request)}</div></td>
  </tr>`).join("");
}

function requestActions(request) {
  const user = state.data.user;
  let actions = "";
  if (request.status === "pending" && isApprover() && (user.role === "admin" || Number(request.approver_id) === user.id)) {
    actions += `<button class="button small secondary" data-action="approve" data-id="${request.id}">Approve</button><button class="button small danger" data-action="reject" data-id="${request.id}">Reject</button>`;
  }
  if (["approved", "partially_issued"].includes(request.status) && isStaff()) actions += `<button class="button small primary" data-action="issue" data-id="${request.id}">Issue</button>`;
  if (["pending", "approved", "partially_issued"].includes(request.status) && (request.requester_id === user.id || user.role === "admin")) actions += `<button class="button small ghost" data-action="cancel" data-id="${request.id}">Cancel</button>`;
  return actions || "—";
}

function renderOverview() {
  const { user, counts, requests, consumables, recentActivity } = state.data;
  const actions = `<button class="button lime" data-action="new-request">＋ New request</button>${isStaff() ? `<button class="button secondary" data-action="receive">Receive stock</button>` : ""}`;
  const lowStock = consumables.filter((item) => item.quantity <= item.reorder_level).slice(0, 5);
  return `${renderWelcome(`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${escapeHtml(user.name.split(" ")[0])}.`, "Here’s what needs attention across your inventory today.", actions)}
    <section class="stats">
      ${statCard("Pending requests", counts.pending, "Awaiting a decision", counts.pending ? "warning" : "")}
      ${statCard("Low-stock items", counts.lowStock, "At or below reorder level", counts.lowStock ? "warning" : "")}
      ${statCard("Overdue loans", counts.overdue, "Expected back already", counts.overdue ? "danger" : "")}
      ${statCard("In maintenance", counts.maintenance, "Assets unavailable")}
    </section>
    <div class="dashboard-grid">
      <div>
        <section class="panel"><div class="panel-header"><h3>Recent requests</h3><button class="button small ghost" data-view="requests">View all</button></div><div class="panel-body flush"><div class="table-wrap"><table><thead><tr><th>Ref</th><th>Request</th><th>Issued</th><th>Status</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${requestRows(requests, 6)}</tbody></table></div></div></section>
        ${isStaff() ? `<section class="panel"><div class="panel-header"><h3>Recent audit activity</h3><button class="button small ghost" data-action="export" data-kind="audit">Export audit</button></div><div class="panel-body">${recentActivity.length ? recentActivity.slice(0, 7).map((activity) => `<div class="activity"><span class="activity-dot"></span><div><p><strong>${escapeHtml(activity.actor_name || "System")}</strong> ${escapeHtml(actionLabel(activity.action))} ${escapeHtml(activity.entity_type)} #${escapeHtml(activity.entity_id)}</p><time>${formatDate(activity.created_at, true)}</time></div></div>`).join("") : `<div class="empty">No recent activity.</div>`}</div></section>` : ""}
      </div>
      <aside>
        <section class="panel"><div class="panel-header"><h3>Low stock</h3><button class="button small ghost" data-view="inventory">Inventory</button></div><div class="panel-body">${lowStock.length ? lowStock.map((item) => `<div class="activity"><span class="activity-dot"></span><div><p><strong>${escapeHtml(item.name)}</strong><br>${formatNumber(item.quantity)} ${escapeHtml(item.unit)} remaining</p><time>Reorder at ${formatNumber(item.reorder_level)}</time></div></div>`).join("") : `<div class="empty"><strong>Stock looks healthy</strong>No items are below their reorder level.</div>`}</div></section>
        <section class="panel"><div class="panel-header"><h3>Shortcuts</h3></div><div class="panel-body"><div class="quick-actions"><button class="button secondary" data-action="new-request">Request an item</button>${isStaff() ? `<button class="button ghost" data-action="new-item">Add inventory</button><button class="button ghost" data-action="new-asset">Register asset</button>` : ""}</div></div></section>
      </aside>
    </div>`;
}

function renderInventory() {
  const items = state.data.consumables.filter((item) => {
    const query = state.search.toLowerCase();
    const matches = !query || `${item.code} ${item.name} ${item.category} ${item.location}`.toLowerCase().includes(query);
    const filter = state.filter !== "low" || item.quantity <= item.reorder_level;
    return matches && filter;
  });
  const actions = isStaff() ? `<button class="button primary" data-action="new-item">＋ Add item</button><button class="button secondary" data-action="receive">Receive stock</button>` : `<button class="button primary" data-action="new-request">＋ Request item</button>`;
  return `${renderWelcome("Consumable inventory", "Monitor balances, reorder points, and every stock movement.", actions)}
    <div class="section-toolbar"><input class="search" data-search placeholder="Search code, item, category, or location…" value="${escapeHtml(state.search)}"><div class="filters"><button class="filter ${state.filter === "all" ? "active" : ""}" data-filter="all">All items</button><button class="filter ${state.filter === "low" ? "active" : ""}" data-filter="low">Low stock</button>${isStaff() ? `<button class="button small ghost" data-action="export" data-kind="inventory">Export CSV</button>` : ""}</div></div>
    <section class="panel"><div class="panel-body flush"><div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>On hand</th><th>Reorder at</th><th>Location</th><th>Unit cost</th>${isStaff() ? "<th>Action</th>" : ""}</tr></thead><tbody>${items.length ? items.map((item) => {
      const low = item.quantity <= item.reorder_level;
      const percent = Math.min(100, Math.round((item.quantity / Math.max(item.reorder_level * 2, 1)) * 100));
      const fill = Math.max(10, Math.ceil(percent / 10) * 10);
      return `<tr><td><span class="cell-title">${escapeHtml(item.name)}</span><span class="cell-sub"><span class="code">${escapeHtml(item.code)}</span></span></td><td>${escapeHtml(item.category)}</td><td><strong>${formatNumber(item.quantity)} ${escapeHtml(item.unit)}</strong><div class="stock-meter ${low ? "low" : ""}"><span class="fill-${fill}"></span></div></td><td>${formatNumber(item.reorder_level)} ${escapeHtml(item.unit)}</td><td>${escapeHtml(item.location)}</td><td>${formatMoney(item.unit_cost)}</td>${isStaff() ? `<td><div class="row-actions"><button class="button small secondary" data-action="receive-item" data-id="${item.id}">Receive</button><button class="button small ghost" data-action="adjust" data-id="${item.id}">Adjust</button></div></td>` : ""}</tr>`;
    }).join("") : `<tr><td colspan="7"><div class="empty"><strong>No matching items</strong>Try a different search or filter.</div></td></tr>`}</tbody></table></div></div></section>`;
}

function renderAssets() {
  const assets = state.data.assets.filter((asset) => {
    const query = state.search.toLowerCase();
    const matches = !query || `${asset.code} ${asset.description} ${asset.category} ${asset.serial_number} ${asset.assigned_name || ""}`.toLowerCase().includes(query);
    return matches && (state.filter === "all" || asset.status === state.filter);
  });
  return `${renderWelcome("Company assets", "See availability, custody, condition, loans, and maintenance at a glance.", `${isStaff() ? `<button class="button primary" data-action="new-asset">＋ Register asset</button><button class="button ghost" data-action="export" data-kind="custody">Export custody</button>` : `<button class="button primary" data-action="new-asset-request">＋ Request an asset</button>`}`)}
    <div class="section-toolbar"><input class="search" data-search placeholder="Search code, description, serial, or assignee…" value="${escapeHtml(state.search)}"><div class="filters">${["all", "available", "assigned", "loaned", "maintenance", "retired"].map((filter) => `<button class="filter ${state.filter === filter ? "active" : ""}" data-filter="${filter}">${filter[0].toUpperCase()}${filter.slice(1)}</button>`).join("")}</div></div>
    <section class="panel"><div class="panel-body flush"><div class="table-wrap"><table><thead><tr><th>Asset</th><th>Category</th><th>Condition</th><th>Status</th><th>Custodian</th><th>Due</th>${isStaff() ? "<th>Action</th>" : ""}</tr></thead><tbody>${assets.length ? assets.map((asset) => {
      const overdue = asset.status === "loaned" && asset.due_at && new Date(asset.due_at) < new Date();
      return `<tr><td><span class="cell-title">${escapeHtml(asset.description)}</span><span class="cell-sub"><span class="code">${escapeHtml(asset.code)}</span> ${escapeHtml(asset.serial_number)}</span></td><td>${escapeHtml(asset.category)}</td><td><span class="badge ${asset.condition}">${asset.condition}</span></td><td><span class="badge ${overdue ? "overdue" : asset.status}">${overdue ? "overdue" : asset.status}</span></td><td>${escapeHtml(asset.assigned_name || "Stockroom")}</td><td>${formatDate(asset.due_at)}</td>${isStaff() ? `<td><div class="row-actions">${["assigned", "loaned"].includes(asset.status) ? `<button class="button small secondary" data-action="return" data-id="${asset.id}">Return</button>` : ""}${!asset.assigned_to && asset.status !== "retired" ? `<button class="button small ghost" data-action="asset-status" data-id="${asset.id}">${asset.status === "maintenance" ? "Make available" : "Update"}</button>` : ""}</div></td>` : ""}</tr>`;
    }).join("") : `<tr><td colspan="7"><div class="empty"><strong>No matching assets</strong>Try a different search or filter.</div></td></tr>`}</tbody></table></div></div></section>`;
}

function renderRequests() {
  const requests = state.data.requests.filter((request) => {
    const query = state.search.toLowerCase();
    return (!query || `${request.id} ${requestName(request)} ${request.requester_name}`.toLowerCase().includes(query)) && (state.filter === "all" || request.status === state.filter);
  });
  return `${renderWelcome("Requests and approvals", "Follow each request from submission to approval and fulfillment.", `<button class="button primary" data-action="new-request">＋ New request</button>`)}
    <div class="section-toolbar"><input class="search" data-search placeholder="Search request, item, or employee…" value="${escapeHtml(state.search)}"><div class="filters">${["all", "pending", "approved", "partially_issued", "issued", "rejected", "cancelled"].map((filter) => `<button class="filter ${state.filter === filter ? "active" : ""}" data-filter="${filter}">${filter === "all" ? "All" : filter.replaceAll("_", " ")}</button>`).join("")}</div></div>
    <section class="panel"><div class="panel-body flush"><div class="table-wrap"><table><thead><tr><th>Ref</th><th>Request</th><th>Issued</th><th>Status</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${requestRows(requests)}</tbody></table></div></div></section>`;
}

function renderAdmin() {
  if (state.data.user.role !== "admin") return `<div class="empty">Administrator access required.</div>`;
  return `${renderWelcome("Administration", "Manage team access, data exchange, audit records, and notification delivery.", `<button class="button primary" data-action="new-user">＋ Add user</button>`)}
    <div class="dashboard-grid">
      <div>
        <section class="panel"><div class="panel-header"><h3>People and access</h3><button class="button small ghost" data-action="load-users">Refresh</button></div><div class="panel-body" id="admin-users"><div class="empty"><strong>Load the user directory</strong><button class="button small secondary" data-action="load-users">View users</button></div></div></section>
        <section class="panel"><div class="panel-header"><h3>CSV import</h3></div><div class="panel-body"><p class="cell-sub">Imports are validated row by row. Errors are reported without hiding successful records.</p><div class="quick-actions"><button class="button secondary" data-action="import" data-kind="consumables">Import consumables</button><button class="button secondary" data-action="import" data-kind="assets">Import assets</button><button class="button secondary" data-action="import" data-kind="users">Import users</button><button class="button secondary" data-action="import" data-kind="opening-balances">Opening balances</button></div></div></section>
      </div>
      <aside>
        <section class="panel"><div class="panel-header"><h3>Data exports</h3></div><div class="panel-body"><div class="quick-actions"><button class="button ghost" data-action="export" data-kind="inventory">Inventory</button><button class="button ghost" data-action="export" data-kind="transactions">Transactions</button><button class="button ghost" data-action="export" data-kind="custody">Asset custody</button><button class="button ghost" data-action="export" data-kind="audit">Audit trail</button></div></div></section>
        <section class="panel"><div class="panel-header"><h3>Email delivery</h3></div><div class="panel-body"><p class="cell-sub">Messages remain queued until an email webhook is configured on the server.</p><div class="quick-actions"><button class="button secondary" data-action="email-queue">View queue</button><button class="button ghost" data-action="retry-email">Retry failed</button></div></div></section>
      </aside>
    </div>`;
}

function showModal(title, subtitle, body, closable = true) {
  modal.dataset.locked = closable ? "false" : "true";
  modalContent.innerHTML = `<div class="modal-head"><div><h2>${title}</h2><p>${subtitle}</p></div>${closable ? `<button class="close-button" data-action="close-modal" aria-label="Close">×</button>` : ""}</div><div class="modal-body">${body}</div>`;
  modal.showModal();
}

function formError(form, message) {
  let element = form.querySelector("[data-error]");
  if (!element) {
    element = document.createElement("div");
    element.className = "form-error";
    form.prepend(element);
  }
  element.textContent = message;
  element.classList.remove("hidden");
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function openRequestModal(type = "consumable") {
  const categories = [...new Set(state.data.assets.map((asset) => asset.category))];
  showModal("New inventory request", "Your assigned manager will review this request.", `<form data-form="request"><div class="form-error hidden" data-error></div>
    <div class="field"><label>Request type</label><select name="type" data-request-type><option value="consumable" ${type === "consumable" ? "selected" : ""}>Consumable supply</option><option value="asset" ${type === "asset" ? "selected" : ""}>Company asset</option></select></div>
    <div data-consumable-fields class="${type === "asset" ? "hidden" : ""}"><div class="field"><label>Item</label><select name="consumableId">${state.data.consumables.map((item) => `<option value="${item.id}">${escapeHtml(item.code)} — ${escapeHtml(item.name)} (${formatNumber(item.quantity)} ${escapeHtml(item.unit)})</option>`).join("")}</select></div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="0.01" step="0.01" value="1"></div></div>
    <div data-asset-fields class="${type === "consumable" ? "hidden" : ""}"><div class="field"><label>Asset category</label><input name="assetCategory" list="asset-categories" value="${escapeHtml(categories[0] || "Laptop")}"><datalist id="asset-categories">${categories.map((category) => `<option value="${escapeHtml(category)}">`).join("")}</datalist></div><div class="field"><label>Assignment</label><select name="assignmentType" data-assignment-type><option value="permanent">Permanent assignment</option><option value="loan">Temporary loan</option></select></div><div class="field hidden" data-due-field><label>Expected return date</label><input name="dueAt" type="date" min="${new Date().toISOString().slice(0, 10)}"></div></div>
    <div class="field"><label>Business purpose</label><textarea name="purpose" required placeholder="Why is this item needed?"></textarea></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Submit request</button></div></form>`);
}

function openStockModal(action, itemId = "") {
  const item = state.data.consumables.find((entry) => entry.id === Number(itemId));
  const receive = action === "receive";
  showModal(receive ? "Receive stock" : "Adjust stock", receive ? "Record a delivery into the main stockroom." : "Enter the counted balance and a reason for the variance.", `<form data-form="stock" data-stock-action="${action}"><div class="form-error hidden" data-error></div>
    <div class="field"><label>Consumable</label><select name="consumableId">${state.data.consumables.map((entry) => `<option value="${entry.id}" ${entry.id === Number(itemId) ? "selected" : ""}>${escapeHtml(entry.code)} — ${escapeHtml(entry.name)} (${formatNumber(entry.quantity)} ${escapeHtml(entry.unit)})</option>`).join("")}</select></div>
    <div class="field"><label>${receive ? "Quantity received" : "New counted quantity"}</label><input name="${receive ? "quantity" : "newQuantity"}" type="number" min="0" step="1" value="${receive ? "1" : escapeHtml(item?.quantity ?? 0)}" required></div>
    <div class="field"><label>Reason / reference</label><input name="reason" required placeholder="e.g. PO-1042 delivery or monthly count"></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Save movement</button></div></form>`);
}

function openItemModal() {
  showModal("Add consumable", "Create an item and its opening balance.", `<form data-form="item"><div class="form-error hidden" data-error></div><div class="field-grid"><div class="field"><label>Item code</label><input name="code" required placeholder="PAPER-A4"></div><div class="field"><label>Item name</label><input name="name" required></div><div class="field"><label>Category</label><input name="category" value="Office Supplies"></div><div class="field"><label>Unit</label><input name="unit" value="piece"></div><div class="field"><label>Opening quantity</label><input name="quantity" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Reorder level</label><input name="reorderLevel" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Unit cost (PHP)</label><input name="unitCost" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Location</label><input name="location" value="Main Stockroom"></div></div><div class="field"><label>Supplier</label><input name="supplier"></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Add item</button></div></form>`);
}

function openAssetModal() {
  showModal("Register company asset", "Assign a unique manual code and record purchase details.", `<form data-form="asset"><div class="form-error hidden" data-error></div><div class="field-grid"><div class="field"><label>Asset code</label><input name="code" required placeholder="LAP-002"></div><div class="field"><label>Description</label><input name="description" required></div><div class="field"><label>Category</label><input name="category" value="Laptop"></div><div class="field"><label>Serial number</label><input name="serialNumber"></div><div class="field"><label>Condition</label><select name="condition"><option>new</option><option selected>good</option><option>fair</option><option>damaged</option></select></div><div class="field"><label>Location</label><input name="location" value="Main Stockroom"></div><div class="field"><label>Purchase date</label><input name="purchaseDate" type="date"></div><div class="field"><label>Purchase cost (PHP)</label><input name="purchaseCost" type="number" min="0" step="0.01" value="0"></div></div><div class="field"><label>Supplier</label><input name="supplier"></div><div class="field"><label>Notes</label><textarea name="notes"></textarea></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Register asset</button></div></form>`);
}

function openDecisionModal(request, action) {
  showModal(`${action === "approve" ? "Approve" : "Reject"} request #${request.id}`, escapeHtml(requestName(request)), `<form data-form="decision" data-id="${request.id}" data-decision="${action}"><div class="form-error hidden" data-error></div><div class="field"><label>Decision note ${action === "reject" ? "(recommended)" : "(optional)"}</label><textarea name="note" placeholder="Add context for the employee and custodian."></textarea></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button ${action === "reject" ? "danger" : "primary"}">${action === "approve" ? "Approve request" : "Reject request"}</button></div></form>`);
}

function openIssueModal(request) {
  if (request.type === "consumable") {
    const item = state.data.consumables.find((entry) => entry.id === request.consumable_id);
    showModal(`Issue request #${request.id}`, `${escapeHtml(item?.name)} · ${formatNumber(item?.quantity)} ${escapeHtml(item?.unit)} available`, `<form data-form="issue" data-id="${request.id}"><div class="form-error hidden" data-error></div><div class="field"><label>Quantity to issue</label><input name="quantity" type="number" min="0.01" step="0.01" max="${Math.min(item?.quantity || 0, request.quantity_requested - request.quantity_issued)}" value="${Math.min(item?.quantity || 0, request.quantity_requested - request.quantity_issued)}" required></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Confirm issue</button></div></form>`);
  } else {
    const available = state.data.assets.filter((asset) => asset.status === "available");
    showModal(`Assign asset for request #${request.id}`, `${escapeHtml(request.asset_category)} · ${escapeHtml(request.assignment_type)}`, `<form data-form="issue" data-id="${request.id}"><div class="form-error hidden" data-error></div><div class="field"><label>Available asset</label><select name="assetId">${available.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.code)} — ${escapeHtml(asset.description)} (${escapeHtml(asset.category)})</option>`).join("")}</select></div><div class="field"><label><input type="checkbox" name="confirmCategoryMismatch" value="true"> Allow a different category if intentionally substituted</label></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary" ${available.length ? "" : "disabled"}>Assign asset</button></div></form>`);
  }
}

function openReturnModal(asset) {
  showModal(`Return ${escapeHtml(asset.code)}`, `Currently assigned to ${escapeHtml(asset.assigned_name || "an employee")}.`, `<form data-form="return" data-id="${asset.id}"><div class="form-error hidden" data-error></div><div class="field"><label>Condition on return</label><select name="condition"><option>new</option><option ${asset.condition === "good" ? "selected" : ""}>good</option><option ${asset.condition === "fair" ? "selected" : ""}>fair</option><option>damaged</option></select></div><div class="field"><label><input type="checkbox" name="sendToMaintenance" value="true"> Send to maintenance after return</label></div><div class="field"><label>Return notes</label><textarea name="notes"></textarea></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Record return</button></div></form>`);
}

function openStatusModal(asset) {
  showModal(`Update ${escapeHtml(asset.code)}`, "Change availability, maintenance, or retirement status.", `<form data-form="asset-status" data-id="${asset.id}"><div class="form-error hidden" data-error></div><div class="field"><label>Status</label><select name="status"><option value="available">Available</option><option value="maintenance" ${asset.status === "maintenance" ? "selected" : ""}>Maintenance</option><option value="retired">Retired</option></select></div><div class="field"><label>Notes</label><textarea name="notes"></textarea></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Update status</button></div></form>`);
}

function openPasswordModal(required = false) {
  showModal(required ? "Secure your account" : "Change password", required ? "Replace the temporary password before continuing." : "Changing your password will sign out your other sessions.", `<form data-form="password"><div class="form-error hidden" data-error></div><div class="field"><label>Current password</label><input type="password" name="currentPassword" required autocomplete="current-password"></div><div class="field"><label>New password</label><input type="password" name="newPassword" minlength="10" required autocomplete="new-password"><span class="cell-sub">Use at least 10 characters.</span></div><div class="modal-actions">${required ? "" : `<button type="button" class="button ghost" data-action="close-modal">Cancel</button>`}<button class="button primary">Change password</button></div></form>`, !required);
  if (required) modal.addEventListener("cancel", preventClose, { once: true });
}

function preventClose(event) { event.preventDefault(); }

function openNotifications() {
  const list = state.data.notifications;
  showModal("Notifications", `${list.filter((item) => !item.read_at).length} unread messages`, `<div class="notification-list">${list.length ? list.map((item) => `<div class="activity"><span class="activity-dot"></span><div><p><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.message)}</p><time>${formatDate(item.created_at, true)}</time></div></div>`).join("") : `<div class="empty">You’re all caught up.</div>`}</div><div class="modal-actions"><button class="button secondary" data-action="mark-read">Mark all read</button></div>`);
}

function openNewUser() {
  showModal("Add team member", "Create a local account with a temporary password.", `<form data-form="user"><div class="form-error hidden" data-error></div><div class="field-grid"><div class="field"><label>Full name</label><input name="name" required></div><div class="field"><label>Email</label><input name="email" type="email" required></div><div class="field"><label>Role</label><select name="role"><option>employee</option><option>manager</option><option>custodian</option><option>admin</option></select></div><div class="field"><label>Temporary password</label><input name="temporaryPassword" type="password" minlength="10" value="ChangeMe123!" required></div></div><div class="field"><label>Manager (optional user ID)</label><input name="managerId" type="number" min="1"></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Create account</button></div></form>`);
}

function openImport(kind) {
  showModal(`Import ${kind.replaceAll("-", " ")}`, "Upload a UTF-8 CSV file. Each invalid row will be listed in the result.", `<form data-form="import" data-kind="${kind}"><div class="form-error hidden" data-error></div><div class="field"><label>CSV file</label><input type="file" name="file" accept=".csv,text/csv" required></div><p class="cell-sub">Expected columns vary by import: consumables use code,name,category,quantity,unit,reorder_level; assets use code,description,category,serial_number; users use name,email,role,temporary_password; opening balances use code,quantity.</p><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button primary">Validate and import</button></div></form>`);
}

async function loadUsers() {
  try {
    const users = await api("/api/admin/users");
    const target = document.querySelector("#admin-users");
    if (!target) return;
    target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Manager</th><th>Status</th><th></th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td><span class="badge">${escapeHtml(user.role)}</span></td><td>${escapeHtml(user.manager_name || "—")}</td><td>${user.active ? "Active" : "Inactive"}${user.must_change_password ? `<span class="cell-sub">Password change required</span>` : ""}</td><td><button class="button small ghost" data-action="reset-password" data-id="${user.id}">Reset password</button></td></tr>`).join("")}</tbody></table></div>`;
  } catch (error) { toast(error.message, "error"); }
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = Number(button.dataset.id);
  const request = state.data?.requests.find((entry) => entry.id === id);
  const asset = state.data?.assets.find((entry) => entry.id === id);
  if (action === "menu") return document.querySelector("#sidebar")?.classList.toggle("open");
  if (action === "close-modal") return modal.close();
  if (action === "new-request") return openRequestModal();
  if (action === "new-asset-request") return openRequestModal("asset");
  if (action === "receive" || action === "receive-item") return openStockModal("receive", id || "");
  if (action === "adjust") return openStockModal("adjust", id);
  if (action === "new-item") return openItemModal();
  if (action === "new-asset") return openAssetModal();
  if (action === "approve" || action === "reject") return openDecisionModal(request, action);
  if (action === "issue") return openIssueModal(request);
  if (action === "return") return openReturnModal(asset);
  if (action === "asset-status") return openStatusModal(asset);
  if (action === "change-password") return openPasswordModal();
  if (action === "notifications") return openNotifications();
  if (action === "new-user") return openNewUser();
  if (action === "load-users") return loadUsers();
  if (action === "import") return openImport(button.dataset.kind);
  if (action === "export") return window.location.assign(`/api/export/${button.dataset.kind}`);
  if (action === "cancel") {
    if (!confirm(`Cancel request #${id}?`)) return;
    await api(`/api/requests/${id}/cancel`, { method: "POST", body: {} });
    toast("Request cancelled.");
    return refresh();
  }
  if (action === "mark-read") {
    await api("/api/notifications/read", { method: "POST", body: {} });
    modal.close();
    return refresh();
  }
  if (action === "retry-email") {
    await api("/api/admin/email-outbox/retry", { method: "POST", body: {} });
    return toast("Queued messages were retried.");
  }
  if (action === "email-queue") {
    const messages = await api("/api/admin/email-outbox");
    return showModal("Email delivery queue", `${messages.filter((item) => item.status !== "sent").length} messages need delivery`, `<div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Subject</th><th>Status</th><th>Attempts</th></tr></thead><tbody>${messages.map((message) => `<tr><td>${escapeHtml(message.recipient)}</td><td>${escapeHtml(message.subject)}<span class="cell-sub">${escapeHtml(message.last_error)}</span></td><td><span class="badge ${message.status === "failed" ? "rejected" : ""}">${message.status}</span></td><td>${message.attempts}</td></tr>`).join("")}</tbody></table></div>`);
  }
  if (action === "reset-password") {
    const temporaryPassword = prompt("Enter a temporary password (at least 10 characters):", "ChangeMe123!");
    if (!temporaryPassword) return;
    await api(`/api/admin/users/${id}/reset-password`, { method: "POST", body: { temporaryPassword } });
    toast("Temporary password set.");
    return loadUsers();
  }
  if (action === "logout") {
    await api("/api/logout", { method: "POST", body: {} });
    return renderLogin();
  }
}

async function handleForm(form) {
  const type = form.dataset.form;
  const data = formData(form);
  try {
    form.querySelector("button[type='submit'], button:not([type])")?.setAttribute("disabled", "");
    if (type === "login") {
      await api("/api/login", { method: "POST", body: data });
      state.view = "overview";
      return refresh();
    }
    if (type === "request") await api("/api/requests", { method: "POST", body: data });
    if (type === "stock") await api(`/api/stock/${form.dataset.stockAction}`, { method: "POST", body: data });
    if (type === "item") await api("/api/consumables", { method: "POST", body: data });
    if (type === "asset") await api("/api/assets", { method: "POST", body: data });
    if (type === "decision") await api(`/api/requests/${form.dataset.id}/${form.dataset.decision}`, { method: "POST", body: data });
    if (type === "issue") await api(`/api/requests/${form.dataset.id}/issue`, { method: "POST", body: { ...data, confirmCategoryMismatch: data.confirmCategoryMismatch === "true" } });
    if (type === "return") await api(`/api/assets/${form.dataset.id}/return`, { method: "POST", body: { ...data, sendToMaintenance: data.sendToMaintenance === "true" } });
    if (type === "asset-status") await api(`/api/assets/${form.dataset.id}/status`, { method: "POST", body: data });
    if (type === "user") await api("/api/admin/users", { method: "POST", body: data });
    if (type === "password") {
      await api("/api/change-password", { method: "POST", body: data });
      modal.close();
      toast("Password changed. Please sign in again.");
      return renderLogin();
    }
    if (type === "import") {
      const file = form.querySelector("input[type=file]").files[0];
      const report = await api(`/api/import/${form.dataset.kind}`, { method: "POST", headers: { "content-type": "text/csv" }, body: await file.text() });
      modal.close();
      toast(`${report.imported} rows imported; ${report.failed} failed.`, report.failed ? "error" : "success");
      if (report.errors.length) showModal("Import completed with errors", "Successful rows were kept; fix and re-import the failed rows.", `<div class="notification-list">${report.errors.map((error) => `<div class="activity"><span class="activity-dot"></span><div><p><strong>Row ${error.row}</strong><br>${escapeHtml(error.message)}</p></div></div>`).join("")}</div>`);
      return refresh(false);
    }
    modal.close();
    toast({ request: "Request submitted.", stock: "Stock balance updated.", item: "Consumable added.", asset: "Asset registered.", decision: "Decision recorded.", issue: "Inventory issued.", return: "Asset return recorded.", "asset-status": "Asset status updated.", user: "User account created." }[type] || "Saved.");
    await refresh();
    if (type === "user" && state.view === "admin") loadUsers();
  } catch (error) {
    formError(form, error.message);
    form.querySelector("button[type='submit'], button:not([type])")?.removeAttribute("disabled");
  }
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    state.view = viewButton.dataset.view;
    state.search = "";
    state.filter = "all";
    render();
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    render();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action) {
    try { await handleAction(action); } catch (error) { toast(error.message, "error"); }
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  handleForm(form);
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-search]")) {
    state.search = event.target.value;
    const position = event.target.selectionStart;
    render();
    const input = document.querySelector("[data-search]");
    input?.focus();
    input?.setSelectionRange(position, position);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-request-type]")) {
    modal.querySelector("[data-consumable-fields]").classList.toggle("hidden", event.target.value !== "consumable");
    modal.querySelector("[data-asset-fields]").classList.toggle("hidden", event.target.value !== "asset");
  }
  if (event.target.matches("[data-assignment-type]")) modal.querySelector("[data-due-field]").classList.toggle("hidden", event.target.value !== "loan");
});

modal.addEventListener("pointerdown", (event) => {
  startedOnBackdrop = event.target === modal;
});

modal.addEventListener("pointerup", (event) => {
  const endedOnBackdrop = event.target === modal;
  if (startedOnBackdrop && endedOnBackdrop && modal.dataset.locked !== "true") modal.close();
  startedOnBackdrop = false;
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
refresh(false);
