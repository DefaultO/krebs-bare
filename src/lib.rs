//! The stock Steam client with everything but the game taken away (`--mods bare`): no menu, no top bar, no profiles, no
//! market, no messages, no rankings, and none of the endpoints behind them. One button stays, `Exit server`.
//!
//! The client's menu is built from `serverData.features[].menuData`: each entry splices one section of the default menu,
//! so `deleteCount` removes what is there and `item` goes in its place. That is how the items go, how `bare.css` gets
//! loaded (a menu `template` is compiled, and a `<link>` with an absolute URL stays a plain element on the page), and how
//! `Exit server` exists: an ordinary item on the client's own `/nw-menu` route, the one `Change server` uses. The rest of
//! the menu, and the top bar, are hidden by `bare.css`, which also pulls that one item out of the hidden menu.
//!
//! With `WORLD_VIEW` off, players land on `landing.html`: the lobby list and Battle Royale (`lobbies`,
//! which runs each match on a server of its own, `world`). The client
//! opens the map through `user/world-start-room`, so with that route gone the map never loads at all, and nothing of the
//! world is fetched or drawn. The game itself keeps ticking. Set `WORLD_VIEW` to true to bring the map and the rooms back.
//!
//! `landing.html` is an ordinary page in a frame on the server's own origin, so it can have controls, and it has no reach
//! into the client. It does not know who is looking, so the frame's `load` handler in `landing_frame` posts it the token the
//! client holds for this server. A menu template is compiled with the client's `CONFIG` in scope, and its `constructor`
//! chain is the only way from there to `localStorage`.
//!
//! Logging in stays multi-user: core maps every Steam ticket to one account, so `steam_ticket` here takes the SteamID from
//! the part of the ticket Steam signed (`ticket`).

use backend::api::auth::{default_code, new_user_doc};
use backend::http::{obj, Request, Response};
use backend::mods::{Manifest, Mod, Registry};
use backend::{authlib, field, obj_set, s, str_field, ApiCtx, Route};
use engine::doc::{Obj, Val};
use engine::world::UserIdx;
use util::json::Json;

mod lobbies;
mod steam;
mod ticket;
mod world;

/// The folder to read page files from on every request, so a reconnect shows an edit. run.bat sets it to this mod's
/// folder. Unset, as for anyone running a released exe, the built-in copies are used and nothing is read from disk.
const PAGES_DIR: &str = "KREBS_PAGES_DIR";
const BUILT_IN_CSS: &str = include_str!("../bare.css");
const BUILT_IN_LANDING: &str = include_str!("../landing.css");
/// The page's files: name, built-in copy, type.
const PAGE_FILES: [(&str, &str, &str); 5] = [
    ("landing.html", include_str!("../landing.html"), "text/html; charset=utf-8"),
    ("landing.js", include_str!("../landing.js"), "text/javascript; charset=utf-8"),
    ("resolve.mjs", include_str!("../resolve.mjs"), "text/javascript; charset=utf-8"),
    ("worldmap.js", include_str!("../worldmap.js"), "text/javascript; charset=utf-8"),
    ("render.js", include_str!("../render.js"), "text/javascript; charset=utf-8"),
];
/// All SIL OFL, licences in `licences/`. The `-ext`, `-cyrillic` and `-greek` files load only for a name that needs them.
const FONTS: [(&str, &[u8]); 6] = [
    ("mono.woff2", include_bytes!("../mono.woff2")),
    ("display.woff2", include_bytes!("../display.woff2")),
    ("display-ext.woff2", include_bytes!("../display-ext.woff2")),
    ("text.woff2", include_bytes!("../text.woff2")),
    ("text-cyrillic.woff2", include_bytes!("../text-cyrillic.woff2")),
    ("text-greek.woff2", include_bytes!("../text-greek.woff2")),
];

macro_rules! sprites {
    ($($name:literal)*) => { &[$(($name, include_str!(concat!("../game-assets/", $name)))),*] };
}

/// What `render.js` draws rooms with.
const SPRITES: &[(&str, &str)] = sprites!("commander-lvl0.svg" "commander-lvl1.svg" "commander-lvl2.svg" "commander-lvl3.svg" "commander-lvl4.svg" "constructedWall.svg" "controller-level.svg" "controller.svg" "creep-npc.svg" "deposit-biomass-fill.svg" "deposit-biomass.svg" "deposit-metal-fill.svg" "deposit-metal.svg" "deposit-mist-fill.svg" "deposit-mist.svg" "deposit-silicon-fill.svg" "deposit-silicon.svg" "executor-lvl0.svg" "executor-lvl1.svg" "executor-lvl2.svg" "executor-lvl3.svg" "executor-lvl4.svg" "extension-border100.svg" "extension-border200.svg" "extension-border50.svg" "extension.svg" "extractor.svg" "factory-border.svg" "factory-highlight.svg" "factory-lvl0.svg" "factory-lvl1.svg" "factory-lvl2.svg" "factory-lvl3.svg" "factory-lvl4.svg" "factory-lvl5.svg" "factory.svg" "flag-secondary.svg" "flag.svg" "invaderCore.svg" "lab-highlight.svg" "lab-mineral.svg" "lab.svg" "link-border.svg" "link-energy.svg" "link.svg" "nuke.svg" "nuker-border.svg" "nuker.svg" "operator-lvl0.svg" "operator-lvl1.svg" "operator-lvl2.svg" "operator-lvl3.svg" "operator-lvl4.svg" "powerBank.svg" "rampart.svg" "ruin.svg" "storage-border.svg" "storage.svg" "terminal-arrows.svg" "terminal-border.svg" "terminal-highlight.svg" "terminal.svg" "tombstone-border.svg" "tombstone-resource.svg" "tough.svg" "tower-base.svg" "tower-rotatable-npc.svg" "tower-rotatable.svg");

/// Off for now, and kept for Battle Royale: the world map and the room view, in place of the landing page.
const WORLD_VIEW: bool = false;
/// The real part of what the server card shows after the client's `v`.
const CARD_VERSION: &str = "0.2";
/// What the world view reads. `user/world-start-room` alone stops the map opening; the rest closes the way to a room.
const WORLD_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/user/world-start-room"),
    ("POST", "/api/game/map-stats"),
    ("GET", "/api/game/room-terrain"),
    ("GET", "/api/game/room-status"),
    ("GET", "/assets/map/*"),
];

/// The default menu has this many sections. Each is emptied, whatever it holds, so `DELETE_ALL` only has to be enough.
const MENU_SECTIONS: u32 = 4;
const DELETE_ALL: u32 = 99;

/// Everything the game itself never calls: the client's other pages and what stood behind them. A few stay because the
/// map and the room do call them: `user/messages/unread-count` (the whole page fails to load without it), `user/find` and
/// `user/rooms` (the map's search box and its owner lookups), `user/decorations/themes` and `user/badge-svg`
/// (every room asks), `register/check-email` (the first-run name screen).
const GONE: &[(&str, &str)] = &[
    ("GET", "/"),
    ("POST", "/api/servers/list"),
    ("GET", "/api/leaderboard/*"),
    ("GET", "/api/game/market/*"),
    ("GET", "/api/game/power-creeps/*"),
    ("POST", "/api/game/power-creeps/*"),
    ("GET", "/api/user/messages/index"),
    ("GET", "/api/user/messages/list"),
    ("POST", "/api/user/messages/*"),
    ("GET", "/api/user/stats"),
    ("GET", "/api/user/overview"),
    ("GET", "/api/user/money-history"),
    ("GET", "/api/user/auth-token"),
    ("GET", "/api/user/decorations/inventory"),
    ("POST", "/api/user/email"),
    ("POST", "/api/user/password"),
    ("POST", "/api/user/notify-prefs"),
    ("POST", "/api/user/set-steam-visible"),
    ("POST", "/api/user/tutorial-done"),
    ("POST", "/api/register/submit"),
    ("POST", "/api/auth/signin"),
    ("GET", "/api/auth/query-token"),
];

fn gone(req: &Request, _ctx: &ApiCtx) -> Response {
    Response::not_found(&req.method, &req.path)
}

/// FNV-1a, so the stylesheet's URL changes with its content: the client is one long-lived page, and a page reuses a URL
/// it already loaded without asking again, whatever the response's headers say.
fn fingerprint(css: &str) -> u64 {
    css.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// A page file from `dir`, or the built-in copy when there is no `dir` or it has no such file.
fn page_text(dir: Option<&std::ffi::OsStr>, name: &str, built_in: &str) -> String {
    dir.and_then(|d| std::fs::read_to_string(std::path::Path::new(d).join(name)).ok()).unwrap_or_else(|| built_in.to_string())
}

fn page(name: &str, built_in: &str) -> String {
    page_text(std::env::var_os(PAGES_DIR).as_deref(), name, built_in)
}

fn stylesheet() -> String {
    let css = page("bare.css", BUILT_IN_CSS);
    if WORLD_VIEW {
        return css;
    }
    css + &page("landing.css", BUILT_IN_LANDING)
}

/// Replaces everything in one section of the client's menu with `item`.
fn section(number: u32, item: Json) -> Json {
    obj(vec![
        ("section", Json::Num(f64::from(number))),
        ("start", Json::Num(0.0)),
        ("deleteCount", Json::Num(f64::from(DELETE_ALL))),
        ("item", item),
    ])
}

/// The frame that shows `landing.html`, passing it the client's token for this server once it has loaded.
fn landing_frame(host: &str) -> String {
    let origin = format!("http://{host}");
    // Runs in the client. The frame loads before the client's own sign-in ends, so besides this first answer it answers the
    // page whenever the page asks, which it does while signed out. All on one key, so only while the client is on this
    // server: the frame stays loaded behind the server list, and the same key holds the next server's token.
    // The page's own Leave server arrives here too: leaving is the client's, so it presses the client's real menu item.
    // So does `signin`, sent when a server restart has ended a sign-in the client still holds: its next token lands on the
    // same key, and only the client can ask Steam for one. Keys go to the page: it prints them, and focus stays out here
    // until something moves it in.
    let hand_over = concat!(
        "function a(e){if(e.source)if(e.source===f.contentWindow){",
        "if(e.data===`leave`)document.querySelector(`li.bare-exit .menu__item`).click();",
        "else if(e.data===`signin`){if(window.nw)angular.element(f).injector().get(`Auth`).signInSteamByTicket()}",
        "else if(new URL(JSON.parse(localStorage.getItem(`session.server`)).apiUrl).origin===o)",
        "e.source.postMessage(localStorage.getItem(k),o)}}",
        "removeEventListener(`message`,f.a);f.a=a;addEventListener(`message`,a);a({source:f.contentWindow});f.focus()",
    );
    format!("<iframe src=\"{origin}/assets/landing.html\" (load)=\"CONFIG.constructor.constructor('f,k,o','{hand_over}')($event.target,'auth','{origin}')\"></iframe>")
}

/// The `serverData.features` entry. `host` is the request's Host header, the address the client reached this server on;
/// `None` if it is anything but a host and port, as it goes into a compiled template.
fn feature(host: &str, css: &str) -> Option<Json> {
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b".:-[]".contains(&b)) {
        return None;
    }
    let link = format!("<link rel=\"stylesheet\" href=\"http://{host}/assets/bare.css?v={:x}\">", fingerprint(css));
    let (class, template) = if WORLD_VIEW { ("bare-hidden", link) } else { ("bare-landing", link + &landing_frame(host)) };
    let stylesheet = obj(vec![("class", Json::Str(class.into())), ("template", Json::Str(template))]);
    let exit = obj(vec![("class", Json::Str("bare-exit".into())), ("label", Json::Str("Exit server".into())), ("routerLink", Json::Str("/nw-menu".into()))]);
    let empty = || obj(vec![("class", Json::Str("bare-hidden".into()))]);
    let mut menu = vec![section(0, stylesheet), section(1, exit)];
    menu.extend((2..MENU_SECTIONS).map(|n| section(n, empty())));
    Some(obj(vec![("name", Json::Str("bare".into())), ("version", Json::Num(1.0)), ("menuData", Json::Arr(menu))]))
}

/// `serverData.features` gets one more entry, and the market's goes.
fn add_feature(version: &mut Json, feature: Json) -> bool {
    let Json::Obj(fields) = version else { return false };
    let Some((_, Json::Obj(server_data))) = fields.iter_mut().find(|(k, _)| k == "serverData") else { return false };
    let Some((_, Json::Arr(features))) = server_data.iter_mut().find(|(k, _)| k == "features") else { return false };
    features.retain(|f| f.get("name").and_then(Json::as_str) != Some("market"));
    features.push(feature);
    true
}

/// The two things on the client's server card that a server sets. `users` must stay a number: the card formats it as one, and
/// 0 hides the line. `packageVersion` is any plain text, shown on hover after the host and a `v` the client adds. Nothing else
/// in the client reads it. A count of nothing stays out, as the line wraps past 230 px and a host takes up to half of that.
fn set_card(version: &mut Json, card: &lobbies::Card) {
    let Json::Obj(fields) = version else { return };
    let mut text = CARD_VERSION.to_string();
    for (count, word) in [(card.open, "open"), (card.live, "live")] {
        if count > 0 {
            text += &format!(", {count} {word}");
        }
    }
    fields.retain(|(key, _)| key != "users" && key != "packageVersion");
    fields.push(("users".into(), Json::Num(card.people as f64)));
    fields.push(("packageVersion".into(), Json::Str(text)));
}

/// GET /api/version: core's answer with the menu and the server card in it.
fn version(req: &Request, ctx: &ApiCtx) -> Response {
    let mut response = backend::server::version(req, ctx);
    let Ok(mut body) = Json::parse(&String::from_utf8_lossy(&response.body)) else { return response };
    if let Some(bare) = req.header("host").and_then(|host| feature(host, &stylesheet())) {
        add_feature(&mut body, bare);
    }
    if !WORLD_VIEW {
        set_card(&mut body, &lobbies::card());
    }
    response.body = body.stringify().into_bytes();
    response
}

/// GET /assets/bare.css
fn css(_req: &Request, _ctx: &ApiCtx) -> Response {
    let mut response = Response::text(200, "text/css; charset=utf-8", &stylesheet());
    response.headers.push(("Cache-Control".into(), "no-store".into()));
    response
}

/// GET /assets/landing.html, landing.js and resolve.mjs
fn page_file(req: &Request, _ctx: &ApiCtx) -> Response {
    let Some((name, built_in, kind)) = PAGE_FILES.iter().find(|(name, ..)| req.path.ends_with(name)) else { return gone(req, _ctx) };
    let mut response = Response::text(200, kind, &page(name, built_in));
    response.headers.push(("Cache-Control".into(), "no-store".into()));
    response
}

/// GET /assets/game-assets/*
fn sprite(req: &Request, ctx: &ApiCtx) -> Response {
    let Some((_, svg)) = SPRITES.iter().find(|(name, _)| req.path.rsplit('/').next() == Some(name)) else { return gone(req, ctx) };
    let mut response = Response::text(200, "image/svg+xml", svg);
    response.headers.push(("Cache-Control".into(), "public, max-age=31536000, immutable".into()));
    response
}

/// GET /assets/*.woff2
fn font(req: &Request, ctx: &ApiCtx) -> Response {
    let Some((_, body)) = FONTS.iter().find(|(name, _)| req.path.rsplit('/').next() == Some(name)) else { return gone(req, ctx) };
    Response {
        status: 200,
        headers: vec![("Content-Type".into(), "font/woff2".into()), ("Cache-Control".into(), "public, max-age=31536000, immutable".into())],
        body: body.to_vec(),
    }
}

fn has_steam_id(doc: &Obj, id: &str) -> bool {
    field(doc, "steam").and_then(Val::as_obj).and_then(|o| str_field(o, "id")) == Some(id)
}

/// The user for a SteamID64, created if new. A new user has no username yet: the client's own screen asks for one.
fn account(ctx: &ApiCtx, id: String) -> Result<UserIdx, String> {
    // an existing user needs no write, and no wait for the next tick's publish
    if let Some(u) = ctx.published.get().users.iter().position(|u| has_steam_id(&u.doc, &id)) {
        return Ok(u as UserIdx);
    }
    backend::write(ctx, move |w| {
        if let Some(u) = w.users.iter().position(|u| has_steam_id(&u.doc, &id)) {
            return Ok(u as UserIdx);
        }
        let mut steam = Obj::new();
        obj_set(&mut steam, "id", s(&id));
        let doc = new_user_doc(w, vec![("steam", Val::Obj(steam))]);
        Ok(backend::add_user(w, doc, Obj::new(), vec![default_code(None)]))
    })
}

/// POST /api/auth/steam-ticket
fn steam_ticket(req: &Request, ctx: &ApiCtx) -> Response {
    let body = req.body();
    if body.get("useNativeAuth").and_then(Json::as_bool) == Some(true) {
        return Response::error("authentication method is not supported");
    }
    let Some(id) = body.get("ticket").and_then(Json::as_str).and_then(ticket::steam_id).map(|id| id.to_string()) else {
        return Response::error("could not authenticate");
    };
    let u = match account(ctx, id.clone()) {
        Ok(u) => u,
        Err(e) => return Response::error(&e),
    };
    // asked for now, so that the name is known before anyone makes a lobby
    steam::picture(&id);
    let view = ctx.published.get();
    let Some(st) = view.users.get(u as usize) else { return Response::error("could not authenticate") };
    Response::ok(obj(vec![("token", Json::Str(authlib::gen_token(st.id.as_str()))), ("steamid", Json::Str(id))]))
}

pub struct Bare;

/// What the server registers (modlist finds it by this name).
pub static MOD: Bare = Bare;

impl Mod for Bare {
    fn manifest(&self) -> Manifest {
        Manifest { name: "bare", version: env!("CARGO_PKG_VERSION"), dependencies: &[] }
    }

    fn register(&self, r: &mut Registry) {
        ticket::key();
        ticket::ask_steam(r.steam_key.clone());
        // the client's welcome dialog only opens for a text
        r.server_data.push(("welcomeText", Json::Str(String::new())));
        r.routes.push(Route { method: "GET", path: "/api/version", handler: version });
        r.routes.push(Route { method: "GET", path: "/assets/bare.css", handler: css });
        r.routes.push(Route { method: "POST", path: "/api/auth/steam-ticket", handler: steam_ticket });
        r.routes.extend(GONE.iter().map(|&(method, path)| Route { method, path, handler: gone }));
        if !WORLD_VIEW {
            lobbies::init(r.data_dir.clone());
            r.routes.push(Route { method: "GET", path: "/assets/landing.html", handler: page_file });
            r.routes.push(Route { method: "GET", path: "/assets/landing.js", handler: page_file });
            r.routes.push(Route { method: "GET", path: "/assets/resolve.mjs", handler: page_file });
            r.routes.push(Route { method: "GET", path: "/assets/worldmap.js", handler: page_file });
            r.routes.push(Route { method: "GET", path: "/assets/render.js", handler: page_file });
            r.routes.push(Route { method: "GET", path: "/assets/game-assets/*", handler: sprite });
            const FONT_ROUTES: [&str; FONTS.len()] = ["/assets/mono.woff2", "/assets/display.woff2", "/assets/display-ext.woff2", "/assets/text.woff2", "/assets/text-cyrillic.woff2", "/assets/text-greek.woff2"];
            r.routes.extend(FONT_ROUTES.map(|path| Route { method: "GET", path, handler: font }));
            r.routes.push(Route { method: "GET", path: "/api/lobbies", handler: lobbies::list });
            r.routes.push(Route { method: "GET", path: "/api/lobbies/map", handler: lobbies::map });
            r.routes.push(Route { method: "GET", path: "/api/lobbies/live", handler: lobbies::live });
            r.routes.push(Route { method: "GET", path: "/api/lobbies/rooms", handler: lobbies::rooms });
            type Action = fn(&Request, &ApiCtx) -> Response;
            let actions: [(&'static str, Action); 9] = [
                ("/api/lobbies/create", lobbies::create),
                ("/api/lobbies/join", lobbies::join),
                ("/api/lobbies/leave", lobbies::leave),
                ("/api/lobbies/ready", lobbies::ready),
                ("/api/lobbies/pick", lobbies::pick),
                ("/api/lobbies/lock", lobbies::lock),
                ("/api/lobbies/spawn", lobbies::spawn),
                ("/api/lobbies/stop", lobbies::stop),
                ("/api/lobbies/upload", lobbies::upload),
            ];
            r.routes.extend(actions.map(|(path, handler)| Route { method: "POST", path, handler }));
            r.routes.extend(WORLD_ROUTES.iter().map(|&(method, path)| Route { method, path, handler: gone }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_menu_section_is_emptied() {
        let bare = feature("127.0.0.1:21025", "a{}").unwrap();
        let menu = bare.get("menuData").unwrap().as_array().unwrap();
        assert_eq!(menu.len(), MENU_SECTIONS as usize);
        assert!(menu.iter().all(|m| m.get("deleteCount").and_then(Json::as_f64) == Some(f64::from(DELETE_ALL)) && m.get("item").is_some()));
    }

    #[test]
    fn the_exit_button_uses_the_clients_own_route() {
        let bare = feature("127.0.0.1:21025", "").unwrap();
        let exit = bare.get("menuData").unwrap().at(1).unwrap().get("item").unwrap();
        assert_eq!(exit.get("label").and_then(Json::as_str), Some("Exit server"));
        assert_eq!(exit.get("routerLink").and_then(Json::as_str), Some("/nw-menu"));
    }

    #[test]
    fn the_stylesheet_url_follows_its_content_and_the_host_is_checked() {
        let template = |css: &str| feature("127.0.0.1:21025", css).unwrap().get("menuData").unwrap().at(0).unwrap().get("item").unwrap().get("template").and_then(Json::as_str).unwrap().to_string();
        assert!(template("a{}").starts_with(&format!(r#"<link rel="stylesheet" href="http://127.0.0.1:21025/assets/bare.css?v={:x}">"#, fingerprint("a{}"))));
        assert_ne!(template("a{}"), template("b{}"), "a change must reach a client that already loaded the old URL");
        assert!(feature("[::1]:21025", "").is_some());
        for bad in ["", "x\"><script>", "a b", "{{1}}"] {
            assert!(feature(bad, "").is_none(), "{bad:?}");
        }
    }

    #[test]
    fn the_server_card_gets_a_number_and_a_line_of_text() {
        let mut version = obj(vec![("ok", Json::Num(1.0)), ("users", Json::Num(9.0))]);
        set_card(&mut version, &lobbies::Card { people: 3, open: 2, live: 1 });
        assert_eq!(version.get("users").and_then(Json::as_f64), Some(3.0), "the card breaks on anything but a number");
        assert_eq!(version.get("packageVersion").and_then(Json::as_str), Some("0.2, 2 open, 1 live"));
        assert_eq!(version.as_object().unwrap().len(), 3, "replaced, not doubled");
        set_card(&mut version, &lobbies::Card { people: 0, open: 0, live: 1 });
        assert_eq!(version.get("packageVersion").and_then(Json::as_str), Some("0.2, 1 live"));
        set_card(&mut version, &lobbies::Card { people: 0, open: 0, live: 0 });
        assert_eq!(version.get("packageVersion").and_then(Json::as_str), Some("0.2"));
    }

    #[test]
    fn the_landing_page_replaces_the_world_view() {
        assert!(!WORLD_VIEW, "turning the map back on? this test goes too");
        let template = feature("127.0.0.1:21025", "").unwrap().get("menuData").unwrap().at(0).unwrap().get("item").unwrap().get("template").and_then(Json::as_str).unwrap().to_string();
        assert!(template.contains(r#"<iframe src="http://127.0.0.1:21025/assets/landing.html""#), "{template}");
        assert!(template.contains("'auth','http://127.0.0.1:21025'"), "the token goes to this server and nowhere else: {template}");
        assert!(stylesheet().contains("li.bare-landing iframe"));
        assert!(PAGE_FILES[0].1.contains("<title>Krebs</title>"));
        assert!(template.contains("f.focus()"), "the page's keys reach it before any click: {template}");
        assert!(template.contains("signInSteamByTicket"), "a restart must not strand the page: {template}");
    }

    #[test]
    fn pages_come_from_disk_only_when_a_folder_is_named() {
        let dir = std::env::temp_dir().join(format!("krebs-bare-pages-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("landing.css"), "edited").unwrap();
        assert_eq!(page_text(None, "landing.css", "built in"), "built in");
        assert_eq!(page_text(Some(dir.as_os_str()), "landing.css", "built in"), "edited");
        assert_eq!(page_text(Some(dir.as_os_str()), "bare.css", "built in"), "built in", "a file the folder lacks stays built in");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_font_is_a_woff2_the_page_asks_for() {
        for (name, body) in FONTS {
            assert_eq!(&body[..4], b"wOF2", "{name}");
            assert!(PAGE_FILES[0].1.contains(&format!("/assets/{name}")), "{name}");
        }
    }
}
