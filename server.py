#!/usr/bin/env python3
"""Jersey store server: serves the pages, runs the JSON API, stores data in SQLite.
Needs Python 3.9+ and nothing else (no pip installs). Run:  python3 server.py"""
import hashlib, hmac, json, os, re, secrets, sqlite3, time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DB_FILE = ROOT / "store.db"
HOST = os.environ.get("HOST", "127.0.0.1")           # use 0.0.0.0 on a server
PORT = int(os.environ.get("PORT", "8000"))
SECURE_COOKIE = os.environ.get("SECURE_COOKIE") == "1"  # set to 1 once your site uses https
SESSION_SECONDS = 14 * 24 * 3600

# ---- Edit these to change sizes, delivery options/fees and payment options ----
SIZES = ["S", "M", "L", "XL", "XXL"]
DELIVERY = {"standard": ("Standard, 3-7 days", 3000),
            "express": ("Express, 1-2 days", 6000),
            "pickup": ("Pickup, free", 0)}
PAYMENT = {"pod": "Pay on delivery", "transfer": "Bank transfer"}
# name, price, old price (or None), main colour, trim colour, number. Only used to fill an EMPTY database.
SEED = [("KANSAS CITY HOME JERSEY", 45000, None, "#e31837", "#ffb81c", "15"),
        ("SAN FRANCISCO AWAY JERSEY", 45000, None, "#f4f1ea", "#aa0000", "13"),
        ("DALLAS HOME JERSEY", 45000, None, "#003594", "#c0c7cc", "4"),
        ("PHILADELPHIA HOME JERSEY", 45000, None, "#004c54", "#c0c7cc", "1"),
        ("BUFFALO HOME JERSEY", 38000, 45000, "#00338d", "#c60c30", "17"),
        ("BALTIMORE HOME JERSEY", 45000, None, "#241773", "#9e7c0c", "8"),
        ("GREEN BAY HOME JERSEY", 45000, None, "#203731", "#ffb612", "10"),
        ("MIAMI HOME JERSEY", 38000, 45000, "#008e97", "#fc4c02", "2")]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT, pw TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
  old_price INTEGER, c1 TEXT, c2 TEXT, num TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  subtotal INTEGER, fee INTEGER, total INTEGER, ship TEXT, pay TEXT, name TEXT, phone TEXT, address TEXT,
  city TEXT, state TEXT, status TEXT DEFAULT 'pending', created REAL);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER, name TEXT, size TEXT, price INTEGER, qty INTEGER);
"""
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ATTEMPTS = {}


def db():
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db():
    con = db()
    with con:
        con.executescript(SCHEMA)
        con.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
        if not con.execute("SELECT 1 FROM products").fetchone():
            con.executemany("INSERT INTO products(name,price,old_price,c1,c2,num) VALUES(?,?,?,?,?,?)", SEED)


def hash_pw(pw):
    salt = secrets.token_bytes(16)
    return salt.hex() + ":" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200_000).hex()


def check_pw(pw, stored):
    salt, h = stored.split(":")
    return hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex(), h)


class Bad(Exception):
    def __init__(self, msg, status=400):
        self.msg, self.status = msg, status


def throttle(ip):  # max 10 login/register attempts per IP per 10 minutes
    now = time.time()
    recent = [t for t in ATTEMPTS.get(ip, []) if now - t < 600]
    if len(recent) >= 10:
        raise Bad("Too many attempts. Try again in a few minutes.", 429)
    ATTEMPTS[ip] = recent + [now]


class Handler(BaseHTTPRequestHandler):
    # ---------- helpers ----------
    def send_json(self, data, status=200, headers=()):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise Bad("Bad request.")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            raise Bad("Request too large.", 413)
        data = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(data, dict):
            raise Bad("Bad request.")
        return data

    def token(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c["sid"].value if "sid" in c else None

    def user(self):
        t = self.token()
        if not t:
            return None
        return db().execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
                            (t, time.time())).fetchone()

    def cookie(self, value, age):
        return f"sid={value}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax" + ("; Secure" if SECURE_COOKIE else "")

    def start_session(self, con, uid, payload):
        token = secrets.token_urlsafe(32)
        with con:
            con.execute("INSERT INTO sessions VALUES(?,?,?)", (token, uid, time.time() + SESSION_SECONDS))
        self.send_json(payload, headers=[("Set-Cookie", self.cookie(token, SESSION_SECONDS))])

    # ---------- GET ----------
    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/products":
                rows = db().execute("SELECT * FROM products ORDER BY id").fetchall()
                self.send_json({"products": [dict(r) for r in rows]})
            elif path == "/api/config":
                self.send_json({"sizes": SIZES, "payment": PAYMENT,
                                "delivery": {k: {"label": l, "fee": f} for k, (l, f) in DELIVERY.items()}})
            elif path == "/api/me":
                u = self.user()
                self.send_json({"user": u and {"name": u["name"], "email": u["email"], "phone": u["phone"]}})
            elif path == "/api/orders":
                u = self.user()
                if not u:
                    raise Bad("Log in to see your orders.", 401)
                con = db()
                orders = [dict(o) for o in con.execute(
                    "SELECT id,subtotal,fee,total,ship,pay,name,phone,address,city,state,status,created "
                    "FROM orders WHERE user_id=? ORDER BY id DESC", (u["id"],))]
                for o in orders:
                    o["items"] = [dict(i) for i in con.execute(
                        "SELECT name,size,price,qty FROM items WHERE order_id=?", (o["id"],))]
                self.send_json({"orders": orders})
            else:
                self.static(path)
        except Bad as e:
            self.send_json({"error": e.msg}, e.status)
        except Exception as e:
            print("ERROR", e)
            self.send_json({"error": "Server error."}, 500)

    def static(self, path):
        f = (PUBLIC / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if PUBLIC.resolve() not in f.parents or not f.is_file():
            self.send_error(404)
            return
        types = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
                 ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", types.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------- POST ----------
    def do_POST(self):
        try:
            routes = {"/api/register": self.register, "/api/login": self.login,
                      "/api/logout": self.logout, "/api/orders": self.order}
            route = routes.get(urlparse(self.path).path)
            if not route:
                raise Bad("Not found.", 404)
            route(self.read_json())
        except Bad as e:
            self.send_json({"error": e.msg}, e.status)
        except json.JSONDecodeError:
            self.send_json({"error": "Bad request."}, 400)
        except Exception as e:
            print("ERROR", e)
            self.send_json({"error": "Server error."}, 500)

    def register(self, d):
        throttle(self.client_address[0])
        name, email, phone = (str(d.get(k, "")).strip() for k in ("name", "email", "phone"))
        pw, email = str(d.get("password", "")), email.lower()
        if not 1 <= len(name) <= 80: raise Bad("Enter your name.")
        if not EMAIL.match(email) or len(email) > 120: raise Bad("Enter a valid email address.")
        if not 8 <= len(pw) <= 200: raise Bad("Password must be at least 8 characters.")
        if len(phone) > 30: raise Bad("Phone number is too long.")
        con = db()
        try:
            with con:
                cur = con.execute("INSERT INTO users(name,email,phone,pw,created) VALUES(?,?,?,?,?)",
                                  (name, email, phone, hash_pw(pw), time.time()))
        except sqlite3.IntegrityError:
            raise Bad("That email already has an account. Log in instead.", 409)
        self.start_session(con, cur.lastrowid, {"ok": True})

    def login(self, d):
        throttle(self.client_address[0])
        con = db()
        u = con.execute("SELECT * FROM users WHERE email=?", (str(d.get("email", "")).strip().lower(),)).fetchone()
        if not u or not check_pw(str(d.get("password", "")), u["pw"]):
            raise Bad("Wrong email or password.", 401)
        self.start_session(con, u["id"], {"ok": True})

    def logout(self, d):
        t = self.token()
        if t:
            con = db()
            with con:
                con.execute("DELETE FROM sessions WHERE token=?", (t,))
        self.send_json({"ok": True}, headers=[("Set-Cookie", self.cookie("", 0))])

    def order(self, d):
        u = self.user()
        if not u:
            raise Bad("Log in to place an order.", 401)
        ship, pay, items = str(d.get("ship")), str(d.get("pay")), d.get("items")
        dv = d.get("delivery") if isinstance(d.get("delivery"), dict) else {}
        if ship not in DELIVERY or pay not in PAYMENT: raise Bad("Choose a delivery method and a payment option.")
        if not isinstance(items, list) or not 1 <= len(items) <= 50: raise Bad("Your cart is empty.")
        info = {k: str(dv.get(k, "")).strip()[:200] for k in ("name", "phone", "address", "city", "state")}
        if not all(info.values()): raise Bad("Fill in all delivery details.")
        con, lines = db(), []
        for it in items:  # prices always come from the database, never from the browser
            try:
                pid, qty, size = int(it["id"]), int(it["qty"]), str(it["size"])
            except (KeyError, TypeError, ValueError):
                raise Bad("Invalid cart item.")
            p = con.execute("SELECT id,name,price FROM products WHERE id=?", (pid,)).fetchone()
            if not p or size not in SIZES or not 1 <= qty <= 20: raise Bad("Invalid cart item.")
            lines.append((p["id"], p["name"], size, p["price"], qty))
        subtotal, fee = sum(l[3] * l[4] for l in lines), DELIVERY[ship][1]
        with con:
            cur = con.execute(
                "INSERT INTO orders(user_id,subtotal,fee,total,ship,pay,name,phone,address,city,state,created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (u["id"], subtotal, fee, subtotal + fee, ship, pay, info["name"], info["phone"],
                 info["address"], info["city"], info["state"], time.time()))
            con.executemany("INSERT INTO items(order_id,product_id,name,size,price,qty) VALUES(?,?,?,?,?,?)",
                            [(cur.lastrowid, *l) for l in lines])
        self.send_json({"ok": True, "orderId": cur.lastrowid, "total": subtotal + fee})


if __name__ == "__main__":
    init_db()
    print(f"Store running at http://{'localhost' if HOST == '127.0.0.1' else HOST}:{PORT}  (Ctrl+C to stop)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
