const base = (title: string, body: string, css = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{font:15px system-ui,sans-serif;margin:0;color:#222;background:#fafafa}header{display:flex;align-items:center;gap:16px;padding:12px 24px;background:#fff;border-bottom:1px solid #ddd}
main{padding:24px;max-width:1100px}.card{display:inline-block;width:240px;margin:0 12px 12px 0;padding:16px;background:#fff;border:1px solid #ddd;border-radius:8px;vertical-align:top}
button,a.btn{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;text-decoration:none;color:#222;display:inline-block}
.sp{flex:1}${css}</style></head><body>${body}</body></html>`;

const svg = (d: string, c = "#333") => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="${d}"/></svg>`;
const TRASH = "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7";
const GEAR = "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2";
const PLUS = "M12 5v14M5 12h14";
const PENCIL = "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3";
const SHARE = "M12 3v13M8 7l4-4 4 4M5 12v8h14v-8";
const SEARCH = "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5";

export const PAGES: Record<string, string> = {
  "/cards": base("Desk shop", `<header><b>DeskShop</b><span class="sp"></span><a class="btn" href="#">Cart (0)</a></header><main><h2>Desks</h2>
<div class="card"><h3>Oak Standing Desk</h3><p>$420</p><button>Add to cart</button></div>
<div class="card"><h3>Walnut Writing Desk</h3><p>$310</p><button>Add to cart</button></div>
<div class="card"><h3>Steel Frame Desk</h3><p>$190</p><button>Add to cart</button></div></main>`),

  "/colors": base("Pick one", `<main><h2>Choose your plan colour</h2><p>Pick the badge you want on your profile.</p>
<button style="background:#2b6cb0;color:#fff;border:0;padding:14px 28px">Choose</button>
<button style="background:#d62828;color:#fff;border:0;padding:14px 28px">Choose</button>
<button style="background:#2f9e44;color:#fff;border:0;padding:14px 28px">Choose</button>
<button style="background:#f4b400;color:#222;border:0;padding:14px 28px">Choose</button></main>`),

  "/icons-noname": base("Editor", `<header><b>Docs</b><span class="sp"></span>
<button id="add">${svg(PLUS)}</button><button id="edit">${svg(PENCIL)}</button><button id="share">${svg(SHARE)}</button><button id="del">${svg(TRASH)}</button><button id="settings">${svg(GEAR)}</button></header><main><h2>Quarterly report</h2><p>Draft text...</p></main>`),

  "/icons-named": base("Editor", `<header><b>Docs</b><span class="sp"></span>
<button id="add" aria-label="New document">${svg(PLUS)}</button><button id="edit" aria-label="Edit">${svg(PENCIL)}</button><button id="share" aria-label="Share">${svg(SHARE)}</button><button id="del" aria-label="Delete">${svg(TRASH)}</button><button id="settings" aria-label="Settings">${svg(GEAR)}</button></header><main><h2>Quarterly report</h2><p>Draft text...</p></main>`),

  "/twins": base("Checkout step", `<main><h2>Payment</h2><p>Your card is being verified. You can continue once the check passes.</p>
<div style="display:flex;gap:40px"><div><p>Express path</p><button id="c1" disabled>Continue</button></div><div><p>Standard path</p><button id="c2">Continue</button></div></div>
<br><br><label><input type="checkbox" id="chk-a" checked> Email me receipts</label><br><label><input type="checkbox" id="chk-b"> Email me offers</label></main>`),

  "/news": base("News", `<main><h2>Latest news</h2>
<div class="card" style="width:900px"><h3>City council approves new bike lanes</h3><p>The vote passed 7-2 on Tuesday...</p><a id="r1" href="#a">Read more</a></div>
<div class="card" style="width:900px"><h3>Solar panels now mandatory on new roofs</h3><p>A regional rule takes effect in 2027...</p><a id="r2" href="#b">Read more</a></div>
<div class="card" style="width:900px"><h3>Local bakery wins national prize</h3><p>The family-run shop beat 400 entrants...</p><a id="r3" href="#c">Read more</a></div>
<div class="card" style="width:900px"><h3>Library extends opening hours</h3><p>Starting next month the library opens until 9pm...</p><a id="r4" href="#d">Read more</a></div></main>`),

  "/nearlinks": base("Help", `<header><a href="#" id="l1">Pricing</a><a href="#" id="l2">Pricing FAQ</a><a href="#" id="l3">Pricing for Teams</a><a href="#" id="l4">Contact sales</a><a href="#" id="l5">Contact support</a></header><main><h2>How can we help?</h2><p>Browse the links above.</p></main>`),

  "/overlay": base("Welcome", `<header><b>Brand</b><span class="sp"></span><button id="signup">Sign up</button><button id="login">Log in</button></header><main><h1>Build faster</h1><button id="cta">Get started</button></main>
<div id="ov" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center"><div style="background:#fff;padding:20px 28px;margin-bottom:40px;border-radius:10px;max-width:640px"><p>We use cookies to improve your experience.</p><button id="ok" style="background:#111;color:#fff">Allow all cookies</button> <button id="no">Only necessary</button> <a id="pol" href="#">Cookie policy</a></div></div>`),

  "/auto": base("Trip", `<main><h2>Where to?</h2><input id="q" value="lis" style="width:320px;padding:8px"><ul role="listbox" id="lb" style="list-style:none;padding:0;margin:0;width:336px;border:1px solid #ccc;background:#fff">
<li role="option" id="o1" style="padding:8px">Lisbon, Portugal</li><li role="option" id="o2" style="padding:8px">Lisburn, United Kingdom</li><li role="option" id="o3" style="padding:8px">Lisieux, France</li><li role="option" id="o4" style="padding:8px">Lismore, Australia</li></ul><br><button id="go">Search trips</button></main>`),

  "/auto-div": base("Assign", `<main><h2>Assign owner</h2><input id="q" value="an" style="width:320px;padding:8px"><div id="lb" style="width:336px;border:1px solid #ccc;background:#fff">
<div class="o" id="o1" style="padding:8px;cursor:pointer"><b>An</b>na Petrova &middot; Design</div><div class="o" id="o2" style="padding:8px;cursor:pointer"><b>An</b>drei Ivanov &middot; Engineering</div><div class="o" id="o3" style="padding:8px;cursor:pointer"><b>An</b>tonio Rossi &middot; Sales</div></div></main>`),

  "/table": base("Users", `<main><h2>Team members</h2><table style="border-collapse:collapse;width:800px;background:#fff"><tr><th align=left>Name</th><th align=left>Role</th><th></th></tr>
${["Maria Lopez|Admin", "John Smith|Editor", "Wei Zhang|Viewer", "Priya Nair|Editor", "Omar Haddad|Viewer"].map((r, i) => `<tr style="border-top:1px solid #ddd"><td style="padding:10px">${r.split("|")[0]}</td><td>${r.split("|")[1]}</td><td><button id="e${i}">Edit</button> <button id="d${i}">Remove</button></td></tr>`).join("")}</table></main>`),

  "/imgcards": base("Pick a topping", `<main><h2>Pick your favourite pizza</h2>
${[["Margherita", "#e63946"], ["Funghi", "#8d6e63"], ["Veggie", "#2a9d8f"], ["Hawaiian", "#f4a261"]].map(([n, c], i) => `<a id="p${i}" href="#${n}" class="card" style="padding:0;text-decoration:none"><img alt="" width="240" height="150" src="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='240' height='150'><rect width='240' height='150' fill='${c}'/><text x='120' y='85' font-size='26' fill='white' text-anchor='middle' font-family='sans-serif'>${n}</text></svg>`)}"></a>`).join("")}</main>`),

  "/calendar": base("Pick a date", `<main><h2>October 2026</h2><div style="display:grid;grid-template-columns:repeat(7,48px);gap:4px">${Array.from({ length: 31 }, (_, i) => `<button id="d${i + 1}" style="padding:10px 0">${i + 1}</button>`).join("")}</div></main>`),

  "/divclick": base("Settings", `<main><h2>Notifications</h2>
<div id="row1" style="padding:14px;background:#fff;border:1px solid #ddd;cursor:pointer;margin-bottom:8px" onclick="1">Email notifications</div>
<div id="row2" style="padding:14px;background:#fff;border:1px solid #ddd;cursor:pointer;margin-bottom:8px" onclick="1">Push notifications</div>
<div id="row3" style="padding:14px;background:#fff;border:1px solid #ddd;cursor:pointer" onclick="1">SMS notifications</div></main>`),

  "/toolbar": base("Search", `<header><b>Shop</b><span class="sp"></span><input placeholder="Search" style="padding:6px;width:260px"><button id="sb" aria-label="Search">${svg(SEARCH)}</button><span style="width:40px"></span><a class="btn" id="cart" href="#" aria-label="Cart">&#128722;</a><a class="btn" id="acct" href="#" aria-label="Account">&#128100;</a></header><main><p>Welcome back.</p></main>`),

  "/similar-buttons": base("Confirm", `<main><h2>Delete project "Alpha"?</h2><p>This cannot be undone.</p>
<div style="display:flex;gap:12px"><button id="cancel" style="padding:12px 30px">Cancel</button><button id="del" style="padding:12px 30px;background:#d62828;color:#fff;border:0">Delete project</button></div>
<hr style="margin:40px 0"><h3>Other project actions</h3><button id="arch">Archive project</button> <button id="dup">Duplicate project</button> <button id="ren">Rename project</button></main>`),
};
