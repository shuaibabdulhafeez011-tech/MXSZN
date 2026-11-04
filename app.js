/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const fmt = v => "N" + v.toLocaleString("en-US").replace(/,/g, " ") + ".00";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const OFFLINE = "<p>Could not reach the server. Start it with <b>python3 server.py</b> and open <b>http://localhost:8000</b>.</p>";

async function api(path, body) {
  const opts = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

const jerseySvg = p => `<svg viewBox="0 0 100 100" style="--c1:${esc(p.c1)};--c2:${esc(p.c2)}"><use href="#jersey"/><text x="50" y="66" text-anchor="middle" font-size="24" font-weight="900" font-family="Archivo,Arial,sans-serif" style="fill:var(--c2)">${esc(p.num)}</text></svg>`;

/* ---------- cart (kept in the browser, so guests can fill it before logging in) ---------- */
const Cart = {
  get() { try { return JSON.parse(localStorage.getItem("cart") || "[]"); } catch { return []; } },
  set(items) { try { localStorage.setItem("cart", JSON.stringify(items)); } catch {} Cart.badge(); },
  add(id, size) {
    const items = Cart.get(), it = items.find(x => x.id === id && x.size === size);
    if (it) it.qty = Math.min(it.qty + 1, 20); else items.push({ id, size, qty: 1 });
    Cart.set(items);
  },
  badge() {
    const n = Cart.get().reduce((s, i) => s + i.qty, 0), el = $("#count");
    if (!el) return;
    el.textContent = n || ""; el.dataset.n = n;
  }
};

/* ---------- header menu ---------- */
const nav = $("#nav"), mb = $("#menuBtn");
mb.addEventListener("click", () => { const o = nav.classList.toggle("open"); mb.setAttribute("aria-expanded", o); });
nav.addEventListener("click", () => { nav.classList.remove("open"); mb.setAttribute("aria-expanded", false); });

/* ---------- favorites (saved in this browser) ---------- */
const Fav = {
  get() { try { return JSON.parse(localStorage.getItem("favs") || "[]"); } catch { return []; } },
  has(id) { return Fav.get().includes(id); },
  toggle(id) {
    const f = Fav.get(), i = f.indexOf(id);
    if (i < 0) f.push(id); else f.splice(i, 1);
    try { localStorage.setItem("favs", JSON.stringify(f)); } catch {}
    Fav.badge(); return i < 0;
  },
  badge() { const el = $("#favCount"); if (el) el.textContent = Fav.get().length || ""; }
};

/* ---------- search ---------- */
const searchBar = $("#searchBar"), qIn = $("#q");
function closeSearch() { if (!qIn) return; qIn.value = ""; qIn.dispatchEvent(new Event("input")); searchBar.hidden = true; }
$("#searchBtn")?.addEventListener("click", () => { if (searchBar.hidden) { searchBar.hidden = false; qIn.focus(); } else closeSearch(); });
qIn?.addEventListener("keydown", e => { if (e.key === "Escape") closeSearch(); });
searchBar?.addEventListener("submit", e => {
  e.preventDefault();
  if (!$("#grid")) location.href = "index.html?q=" + encodeURIComponent(qIn.value.trim()) + "#store";
});
const matches = (p, q) => {
  const text = (p.name + (p.old_price ? " sale" : "")).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w));
};

/* ---------- product cards (store + favorites pages) ---------- */
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20Z"/></svg>';
const cardHtml = (p, sizes) => `
  <article class="card" data-id="${p.id}">
    <div class="img">${p.old_price ? '<span class="tag">On sale</span>' : ""}${jerseySvg(p)}
      <button class="heart" aria-label="Save to favorites" aria-pressed="${Fav.has(p.id)}">${HEART}</button></div>
    <h3>${esc(p.name)}</h3>
    <div class="price">${p.old_price ? `<span class="now">${fmt(p.price)}</span><s>${fmt(p.old_price)}</s>` : fmt(p.price)}</div>
    <select aria-label="Size">${sizes.map(s => `<option>${s}</option>`).join("")}</select>
    <button class="btn" data-add>Add to Cart</button>
  </article>`;

function bindCards(grid, onUnfav) {
  grid.addEventListener("click", e => {
    const card = e.target.closest(".card"); if (!card) return;
    const id = +card.dataset.id, heart = e.target.closest(".heart");
    if (heart) {
      const on = Fav.toggle(id);
      heart.setAttribute("aria-pressed", on);
      toast(on ? "Saved to favorites" : "Removed from favorites");
      if (!on && onUnfav) onUnfav();
    } else if (e.target.closest("[data-add]")) {
      Cart.add(id, $("select", card).value);
      toast($("h3", card).textContent + " added to cart");
    }
  });
}

/* ---------- store page ---------- */
async function initStore() {
  const grid = $("#grid");
  try {
    const [{ products }, cfg] = await Promise.all([api("/products"), api("/config")]);
    const show = () => {
      const q = (qIn?.value || "").trim(), list = products.filter(p => matches(p, q));
      grid.innerHTML = list.map(p => cardHtml(p, cfg.sizes)).join("");
      const nr = $("#noResults"); if (nr) nr.hidden = list.length > 0;
      if (nr) nr.textContent = `No jerseys match “${q}”. Try a team name like Dallas, or the word sale.`;
    };
    bindCards(grid);
    qIn?.addEventListener("input", () => {
      show();
      if (qIn.value.trim() && $("#store").getBoundingClientRect().top > 150) $("#store").scrollIntoView();
    });
    const start = new URLSearchParams(location.search).get("q");
    if (start && qIn) { searchBar.hidden = false; qIn.value = start; }
    show();
  } catch { grid.innerHTML = OFFLINE; }
}

/* ---------- favorites page ---------- */
async function initFavs() {
  const grid = $("#favGrid");
  try {
    const [{ products }, cfg] = await Promise.all([api("/products"), api("/config")]);
    const show = () => {
      const list = products.filter(p => Fav.has(p.id));
      grid.innerHTML = list.map(p => cardHtml(p, cfg.sizes)).join("");
      $("#favEmpty").hidden = list.length > 0;
    };
    bindCards(grid, show);
    show();
  } catch { grid.innerHTML = OFFLINE; }
}

/* ---------- cart + checkout page ---------- */
async function initCart() {
  let products, cfg, me;
  try { [{ products }, cfg, me] = await Promise.all([api("/products"), api("/config"), api("/me")]); }
  catch { $("#cartItems").innerHTML = OFFLINE; return; }

  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  const form = $("#checkout"), val = n => form.elements[n].value;
  $("#shipOpts").innerHTML = Object.entries(cfg.delivery).map(([k, d], i) =>
    `<label><span><input type="radio" name="ship" value="${k}" ${i ? "" : "checked"}> ${esc(d.label)}</span><span>${d.fee ? fmt(d.fee) : "Free"}</span></label>`).join("");
  $("#payOpts").innerHTML = Object.entries(cfg.payment).map(([k, l], i) =>
    `<label><span><input type="radio" name="pay" value="${k}" ${i ? "" : "checked"}> ${esc(l)}</span></label>`).join("");
  if (me.user) { form.elements["name"].value = me.user.name; form.elements["phone"].value = me.user.phone || ""; }
  else $("#authNote").innerHTML = 'You need an account to order. <a class="u" href="account.html?next=cart.html">Log in or create one</a>.';

  const render = () => {
    const items = Cart.get().filter(i => byId[i.id]);
    Cart.set(items);
    $("#cartItems").innerHTML = items.length ? items.map(i => {
      const p = byId[i.id], k = `${i.id}|${i.size}`;
      return `<div class="row-item">
        <div class="img">${jerseySvg(p)}</div>
        <div><strong>${esc(p.name)}</strong><div class="meta">Size ${esc(i.size)}</div>
          <div class="qty"><button data-act="dec" data-k="${k}" aria-label="Fewer">&minus;</button><span>${i.qty}</span><button data-act="inc" data-k="${k}" aria-label="More">+</button></div>
          <button class="link" data-act="del" data-k="${k}">Remove</button></div>
        <strong>${fmt(p.price * i.qty)}</strong></div>`;
    }).join("") : '<p>Your cart is empty. <a class="u" href="index.html#store">Browse jerseys</a></p>';
    form.hidden = !items.length;
    const sub = items.reduce((n, i) => n + byId[i.id].price * i.qty, 0), fee = cfg.delivery[val("ship")].fee;
    $("#sum").innerHTML = `<div><span>Subtotal</span><span>${fmt(sub)}</span></div><div><span>Delivery</span><span>${fee ? fmt(fee) : "Free"}</span></div><div class="tot"><span>Total</span><span>${fmt(sub + fee)}</span></div>`;
  };

  $("#cartItems").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const [id, size] = b.dataset.k.split("|"), items = Cart.get(), it = items.find(x => x.id == id && x.size === size);
    if (!it) return;
    if (b.dataset.act === "inc") it.qty = Math.min(it.qty + 1, 20);
    if (b.dataset.act === "dec") it.qty--;
    Cart.set(items.filter(x => x.qty > 0 && !(b.dataset.act === "del" && x === it)));
    render();
  });
  form.addEventListener("change", render);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#err"), btn = $("#placeBtn"); err.textContent = "";
    if (!me.user) { location.href = "account.html?next=cart.html"; return; }
    const delivery = Object.fromEntries(["name", "phone", "address", "city", "state"].map(k => [k, val(k).trim()]));
    if (Object.values(delivery).some(v => !v)) { err.textContent = "Fill in all delivery details."; return; }
    btn.disabled = true;
    try {
      const r = await api("/orders", { items: Cart.get(), delivery, ship: val("ship"), pay: val("pay") });
      Cart.set([]);
      $("#cartLayout").hidden = true;
      $("#done").hidden = false;
      $("#done").innerHTML = `<h2>Order placed</h2><p>Your order number is <strong>#${r.orderId}</strong>. Total: <strong>${fmt(r.total)}</strong>.</p>
        <p>We will contact you on ${esc(delivery.phone)} to confirm payment and delivery.</p>
        <a class="btn" href="account.html">View my orders</a>`;
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  });
  render();
}

/* ---------- account page ---------- */
async function initAccount() {
  let me;
  try { me = await api("/me"); } catch { $("#accountPage").innerHTML = OFFLINE; return; }
  if (me.user) return showOrders(me.user);
  const next = new URLSearchParams(location.search).get("next") === "cart.html" ? "cart.html" : "account.html";
  $("#authBox").hidden = false;
  const tabs = document.querySelectorAll(".tabs button");
  tabs.forEach(b => b.onclick = () => {
    tabs.forEach(x => x.classList.toggle("on", x === b));
    $("#loginForm").hidden = b.dataset.tab !== "login";
    $("#registerForm").hidden = b.dataset.tab !== "register";
  });
  for (const [id, path] of [["loginForm", "/login"], ["registerForm", "/register"]]) {
    $("#" + id).addEventListener("submit", async e => {
      e.preventDefault();
      const f = e.target, err = $(".err", f), btn = $(".btn", f);
      err.textContent = ""; btn.disabled = true;
      try { await api(path, Object.fromEntries(new FormData(f))); location.href = next; }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    });
  }
}

async function showOrders(user) {
  $("#ordersBox").hidden = false;
  $("#hello").textContent = "Hi, " + user.name;
  $("#logout").onclick = async () => { await api("/logout", {}); location.href = "index.html"; };
  try {
    const { orders } = await api("/orders");
    $("#orders").innerHTML = orders.length ? orders.map(o => `
      <div class="order">
        <div class="head"><strong>Order #${o.id}</strong><span class="pill">${esc(o.status)}</span></div>
        <div class="meta">${new Date(o.created * 1000).toLocaleDateString()}</div>
        ${o.items.map(i => `<div class="line"><span>${i.qty} x ${esc(i.name)} (${esc(i.size)})</span><span>${fmt(i.price * i.qty)}</span></div>`).join("")}
        <div class="line"><span>Delivery</span><span>${o.fee ? fmt(o.fee) : "Free"}</span></div>
        <div class="line tot"><span>Total</span><span>${fmt(o.total)}</span></div>
        <div class="meta">Deliver to: ${esc(o.name)}, ${esc(o.address)}, ${esc(o.city)}, ${esc(o.state)}. ${esc(o.phone)}</div>
      </div>`).join("") : '<p>No orders yet. <a class="u" href="index.html#store">Browse jerseys</a></p>';
  } catch (x) { $("#orders").textContent = x.message; }
}

Cart.badge();
Fav.badge();
if ($("#grid")) initStore();
if ($("#favPage")) initFavs();
if ($("#cartPage")) initCart();
if ($("#accountPage")) initAccount();
