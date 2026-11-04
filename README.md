# Jersey store

Run it (needs Python 3.9+, nothing to install):

    cd store
    python3 server.py

Then open http://localhost:8000

- Pages: `public/index.html` (store), `public/cart.html` (cart, delivery, checkout), `public/account.html` (login, sign up, my orders)
- Database: `store.db` is created automatically on first run (users, sessions, products, orders, items)
- Products, sizes, delivery fees and payment options: top of `server.py`. Products are only added when the database is empty; after that, change them in `store.db` (e.g. with DB Browser for SQLite)
- Orders: open `store.db` and look at the `orders` and `items` tables. Change `status` as you confirm payment and ship
- Before going live: serve over HTTPS and run with `SECURE_COOKIE=1 HOST=0.0.0.0 python3 server.py`
